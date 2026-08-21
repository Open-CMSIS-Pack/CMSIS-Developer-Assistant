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
import { SkillCatalog, resolveDesiredSkills } from '../utils/skillCatalog';
import {
    SKILL_MARKER_FILE,
    SkillInstaller,
    SkillMarker,
    getSkillInstallRoots,
    hideFromMenu,
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

    const catalog: SkillCatalog = {
        schemaVersion: 1,
        source: { repository: 'r', sha: 'feedface', sourcePath: 'p' },
        skills: [
            { name: 'cmsis-debug-live', description: 'bundled', category: 'debug', kind: 'skill', source: 'bundled', path: 'skills/cmsis-debug-live', dependsOn: [] },
            { name: 'cmsis-help', description: 'bundled help', category: 'help', kind: 'skill', source: 'bundled', path: 'skills/cmsis-help', dependsOn: [] },
            { name: 'r-pack', description: 'router', category: 'pack', kind: 'router', source: 'generated', path: 'skills/r-pack', dependsOn: ['gen'] },
            { name: 'gen', description: 'gen', category: 'pack', kind: 'skill', source: 'cmsis-skills', path: 'skills/cmsis-skills/gen', dependsOn: [] },
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

    const installer = (): SkillInstaller =>
        new SkillInstaller(extensionPath, '9.9.9', { install: [rootA, rootB], sweepOnly: [] });

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

    test('installs the explicit picks into every root with a marker', async () => {
        const report = await installer().sync(catalog, ['cmsis-debug-live'], []);
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
        await installer().sync(catalog, ['gen'], []);
        assert.strictEqual(readMarker(rootA, 'gen').sha, 'feedface');
        assert.strictEqual(readMarker(rootA, 'gen').source, 'cmsis-skills');
    });

    test('implied skills are installed hidden from the slash menu, explicit ones are not', async () => {
        await installer().sync(catalog, ['r-pack'], ['gen']);
        const router = fs.readFileSync(path.join(rootA, 'r-pack', 'SKILL.md'), 'utf8');
        const member = fs.readFileSync(path.join(rootA, 'gen', 'SKILL.md'), 'utf8');
        assert.ok(!/user-invocable/.test(router), 'the router stays user-invocable');
        assert.match(member, /^user-invocable: false$/m);
        assert.match(member, /^---\nname: gen\ndescription: gen does things\.\nuser-invocable: false\n---\n# gen\n$/,
            'the flag is injected inside the frontmatter and nothing else changes');
        assert.strictEqual(readMarker(rootA, 'gen').hidden, true);
    });

    test('a skill promoted from implied to explicit becomes visible again', async () => {
        await installer().sync(catalog, ['r-pack'], ['gen']);
        await installer().sync(catalog, ['r-pack', 'gen'], []);
        assert.ok(!/user-invocable/.test(fs.readFileSync(path.join(rootA, 'gen', 'SKILL.md'), 'utf8')));
        assert.strictEqual(readMarker(rootA, 'gen').hidden, false);
    });

    test('re-sync replaces the directory, so files dropped from the bundle disappear', async () => {
        await installer().sync(catalog, ['gen'], []);
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'references', 'contract.md')));
        fs.rmSync(path.join(extensionPath, 'skills', 'cmsis-skills', 'gen', 'references'), { recursive: true });
        await installer().sync(catalog, ['gen'], []);
        assert.ok(!fs.existsSync(path.join(rootA, 'gen', 'references', 'contract.md')), 'stale file survived');
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'SKILL.md')));
        assert.ok(!fs.existsSync(path.join(rootA, `.gen.tmp-${process.pid}`)), 'staging dir left behind');
    });

    test('deselecting removes only directories this extension installed', async () => {
        await installer().sync(catalog, ['cmsis-debug-live', 'gen'], []);
        // A user's own skill, no marker:
        writeSkill(path.join(rootA, 'my-own-skill'), 'my-own-skill');
        // A user's own skill that happens to share a catalog name, no marker:
        writeSkill(path.join(rootB, 'gen'), 'gen');
        fs.rmSync(path.join(rootB, 'gen', SKILL_MARKER_FILE), { force: true });

        const report = await installer().sync(catalog, ['cmsis-debug-live'], []);

        assert.ok(!fs.existsSync(path.join(rootA, 'gen')), 'our marked copy should be removed');
        assert.ok(fs.existsSync(path.join(rootA, 'my-own-skill', 'SKILL.md')), 'user skill must survive');
        assert.ok(fs.existsSync(path.join(rootB, 'gen', 'SKILL.md')), 'user skill sharing a catalog name must survive');
        assert.deepStrictEqual(report.removed, [{ root: rootA, name: 'gen' }]);
    });

    test('disabling the AI Skills Pack removes the pack skills this extension installed and keeps the bundled ones', async () => {
        const enabled = resolveDesiredSkills(catalog, ['r-pack']);
        await installer().sync(catalog, enabled.explicit, enabled.implied);
        assert.ok(fs.existsSync(path.join(rootA, 'r-pack', 'SKILL.md')));
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'SKILL.md')));
        writeSkill(path.join(rootA, 'my-own-skill'), 'my-own-skill');

        const disabled = resolveDesiredSkills(catalog, ['r-pack'], { packEnabled: false });
        const report = await installer().sync(catalog, disabled.explicit, disabled.implied);

        for (const root of [rootA, rootB]) {
            assert.ok(!fs.existsSync(path.join(root, 'r-pack')), 'router should be removed');
            assert.ok(!fs.existsSync(path.join(root, 'gen')), 'member should be removed');
            assert.ok(fs.existsSync(path.join(root, 'cmsis-debug-live', 'SKILL.md')), 'bundled skill stays');
            assert.ok(fs.existsSync(path.join(root, 'cmsis-help', 'SKILL.md')), 'bundled help stays');
        }
        assert.ok(fs.existsSync(path.join(rootA, 'my-own-skill', 'SKILL.md')), 'user skill must survive');
        assert.deepStrictEqual(report.removed.map(r => r.name).sort(), ['gen', 'gen', 'r-pack', 'r-pack']);
        assert.deepStrictEqual(disabled.suppressed, ['r-pack']);
    });

    test('never overwrites a foreign skill directory of the same name', async () => {
        writeSkill(path.join(rootA, 'gen'), 'gen', { 'mine.md': 'keep me' });
        const report = await installer().sync(catalog, ['gen'], []);
        assert.deepStrictEqual(report.skippedForeign, [{ root: rootA, name: 'gen' }]);
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'mine.md')));
        assert.ok(!fs.existsSync(path.join(rootA, 'gen', SKILL_MARKER_FILE)));
        // The other root, where nothing was in the way, is installed normally.
        assert.ok(fs.existsSync(path.join(rootB, 'gen', SKILL_MARKER_FILE)));
    });

    test('an unmarked cmsis-debug-live from an earlier release is replaced and can be removed', async () => {
        writeSkill(path.join(rootA, 'cmsis-debug-live'), 'cmsis-debug-live', { 'old.md': 'from 2.0' });
        await installer().sync(catalog, ['cmsis-debug-live'], []);
        assert.ok(!fs.existsSync(path.join(rootA, 'cmsis-debug-live', 'old.md')));
        assert.ok(fs.existsSync(path.join(rootA, 'cmsis-debug-live', SKILL_MARKER_FILE)));

        writeSkill(path.join(rootB, 'cmsis-debug-live'), 'cmsis-debug-live');
        fs.rmSync(path.join(rootB, 'cmsis-debug-live', SKILL_MARKER_FILE), { force: true });
        const report = await installer().sync(catalog, [], []);
        assert.ok(!fs.existsSync(path.join(rootB, 'cmsis-debug-live')));
        assert.ok(report.removed.some(r => r.root === rootB && r.name === 'cmsis-debug-live'));
    });

    test('an unmarked directory named cmsis-debug-live with a different skill inside is left alone', async () => {
        writeSkill(path.join(rootA, 'cmsis-debug-live'), 'something-else');
        const report = await installer().sync(catalog, ['cmsis-debug-live'], []);
        assert.deepStrictEqual(report.skippedForeign, [{ root: rootA, name: 'cmsis-debug-live' }]);
    });

    test('sweep-only roots lose our leftovers but are not written to', async () => {
        const legacy = path.join(tmp, 'home', '.copilot', 'skills');
        writeSkill(path.join(legacy, 'cmsis-debug-live'), 'cmsis-debug-live');
        writeSkill(path.join(legacy, 'theirs'), 'theirs');
        const sut = new SkillInstaller(extensionPath, '9.9.9', { install: [rootA], sweepOnly: [legacy] });
        await sut.sync(catalog, ['cmsis-debug-live', 'gen'], []);
        assert.ok(!fs.existsSync(path.join(legacy, 'cmsis-debug-live')));
        assert.ok(fs.existsSync(path.join(legacy, 'theirs', 'SKILL.md')));
        assert.ok(!fs.existsSync(path.join(legacy, 'gen')));
    });

    test('a missing bundled skill is reported, not thrown', async () => {
        const broken: SkillCatalog = { ...catalog, skills: [...catalog.skills, { name: 'ghost', description: '', category: 'devops', kind: 'skill', source: 'cmsis-skills', path: 'skills/cmsis-skills/ghost', dependsOn: [] }] };
        const report = await installer().sync(broken, ['ghost', 'gen'], []);
        assert.strictEqual(report.failed.filter(f => f.name === 'ghost').length, 2);
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'SKILL.md')), 'other skills still install');
    });

    test('an unwritable root fails on its own and the others still install', async function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) {
            this.skip();
        }
        const locked = path.join(tmp, 'locked');
        fs.mkdirSync(locked, { mode: 0o500 });
        const sut = new SkillInstaller(extensionPath, '9.9.9', { install: [path.join(locked, 'skills'), rootA], sweepOnly: [] });
        try {
            const report = await sut.sync(catalog, ['gen'], []);
            assert.ok(report.failed.some(f => f.root === path.join(locked, 'skills')));
            assert.ok(fs.existsSync(path.join(rootA, 'gen', 'SKILL.md')));
        } finally {
            fs.chmodSync(locked, 0o700);
        }
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
