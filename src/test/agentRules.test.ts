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
import * as path from 'path';
import {
    RULES_PROVENANCE,
    RuleAgentId,
    RuleFileProbe,
    RuleFileRecord,
    RuleFileTarget,
    RuleTargetContext,
    parseRuleRecords,
    ruleFileTargets,
    rulesBlockBody,
    rulesState,
    withRecordedTargets,
    withRules,
    withoutRules,
} from '../core/agentRules';
import { RULES_BLOCK, RULES_HEADING } from '../core/toolContract';
import {
    RuleChange,
    RuleChoice,
    RuleFileSystem,
    RuleLog,
    RuleRecordStore,
    RuleRefreshUi,
    RuleStepDeps,
    RuleStepUi,
    refreshRecordedRules,
    runRuleStep,
} from '../utils/agentRuleFiles';
import { beginMarker, endMarker } from '../utils/markerBlock';

/**
 * The tool rules step writes into files other programs read — a user's
 * CLAUDE.md, a team's AGENTS.md — so everything here runs against an
 * in-memory file system: nothing a test does can reach the real home
 * directory. The step's promises: a change the user does not confirm writes
 * nothing, a file several agents share is written once, taking the rules out
 * leaves the file as it was (or no file, when it was made for them), and
 * activation only ever updates a block that is already there, and only
 * after the user asked to review the update and confirmed it.
 */

const ROOT = path.resolve(path.sep, 'fake-disk');
const HOME = path.join(ROOT, 'home');
const WS = path.join(ROOT, 'work', 'blinky');
const FOLDER = { name: 'blinky', path: WS };

const RULES = `${RULES_HEADING}\n\nOnly the user can lift a rule.\n\n- Talk to the board through the tools.\n- Never install pyOCD.`;
const OLD_RULES = `${RULES_HEADING}\n\n- Talk to the board through the tools.`;

const at = (...parts: string[]): string => path.join(...parts);

/** Files and directories in memory; `writes` lists every file written, in order. */
class FakeDisk implements RuleFileSystem {
    readonly files = new Map<string, string>();
    readonly dirs = new Set<string>([ROOT]);
    readonly writes: string[] = [];
    readonly removed: string[] = [];

    constructor(seed: Record<string, string> = {}, dirs: string[] = []) {
        for (const dir of dirs) {
            this.addDirs(dir);
        }
        for (const [file, text] of Object.entries(seed)) {
            this.addDirs(path.dirname(file));
            this.files.set(file, text);
        }
    }

    private addDirs(dir: string): void {
        for (let at = dir; !this.dirs.has(at); at = path.dirname(at)) {
            this.dirs.add(at);
        }
    }

    private hasBelow(dir: string): boolean {
        return [...this.files.keys(), ...this.dirs].some((entry) => entry !== dir && entry.startsWith(dir + path.sep));
    }

    async read(file: string): Promise<string | undefined> {
        return this.files.get(file);
    }

    async write(file: string, text: string): Promise<void> {
        if (!this.dirs.has(path.dirname(file))) {
            throw new Error(`ENOENT: no directory for ${file}`);
        }
        this.files.set(file, text);
        this.writes.push(file);
    }

    async makeParentDirs(file: string): Promise<string[]> {
        const missing: string[] = [];
        for (let dir = path.dirname(file); !this.dirs.has(dir); dir = path.dirname(dir)) {
            missing.unshift(dir);
        }
        missing.forEach((dir) => this.dirs.add(dir));
        return missing;
    }

    async remove(file: string): Promise<void> {
        this.files.delete(file);
        this.removed.push(file);
    }

    async removeDirIfEmpty(dir: string): Promise<boolean> {
        if (!this.dirs.has(dir) || this.hasBelow(dir)) {
            return false;
        }
        this.dirs.delete(dir);
        this.removed.push(dir);
        return true;
    }

    probe(): RuleFileProbe {
        return {
            kind: (target) => (this.files.has(target) ? 'file' : this.dirs.has(target) ? 'directory' : undefined),
            hasText: (file) => (this.files.get(file) ?? '').trim().length > 0,
            hasEntries: (dir) => this.dirs.has(dir) && this.hasBelow(dir),
        };
    }
}

/** globalState in memory. */
class MemoryStore implements RuleRecordStore {
    constructor(public records: RuleFileRecord[] = []) {}
    read(): RuleFileRecord[] {
        return this.records.map((record) => ({ ...record, agents: [...record.agents], createdDirs: [...record.createdDirs] }));
    }
    async write(records: RuleFileRecord[]): Promise<void> {
        this.records = records;
    }
}

/** A log that keeps its lines, for the "and log it" promises. */
function keptLog(): RuleLog & { lines: string[] } {
    const lines: string[] = [];
    return { lines, info: (message) => lines.push(message), warn: (message) => lines.push(`WARN ${message}`) };
}

/** The user: which files stay checked, and the answer to each preview. */
function scriptedUser(
    check: (choices: readonly RuleChoice[]) => ReadonlySet<string> | undefined,
    confirm: (change: RuleChange) => boolean,
): RuleStepUi & { offered: RuleChoice[][]; previewed: RuleChange[] } {
    const offered: RuleChoice[][] = [];
    const previewed: RuleChange[] = [];
    return {
        offered,
        previewed,
        choose: async (choices) => {
            offered.push([...choices]);
            return check(choices);
        },
        confirm: async (change) => {
            previewed.push(change);
            return confirm(change);
        },
    };
}

/** Accept the picker as it opens. */
/** The user at activation: whether to review the offered updates, and the answer to each preview. */
function refreshUser(review: boolean, confirm: (change: RuleChange) => boolean): RuleRefreshUi & { offers: RuleChange[][]; previewed: RuleChange[] } {
    const offers: RuleChange[][] = [];
    const previewed: RuleChange[] = [];
    return {
        offers,
        previewed,
        offer: async (changes) => {
            offers.push([...changes]);
            return review;
        },
        confirm: async (change) => {
            previewed.push(change);
            return confirm(change);
        },
    };
}

const keepChecked = (choices: readonly RuleChoice[]): ReadonlySet<string> =>
    new Set(choices.filter((choice) => choice.checked).map((choice) => choice.target.file));
const always = (): boolean => true;
const never = (): boolean => false;

function context(disk: FakeDisk, extra: Partial<RuleTargetContext> = {}): RuleTargetContext {
    return { home: HOME, env: {}, folders: [FOLDER], probe: disk.probe(), copilotChatReadsAgentsMd: true, ...extra };
}

function targets(disk: FakeDisk, agents: RuleAgentId[], extra: Partial<RuleTargetContext> = {}): RuleFileTarget[] {
    return ruleFileTargets(agents, context(disk, extra));
}

function deps(disk: FakeDisk, store: MemoryStore, log: RuleLog = keptLog()): RuleStepDeps {
    return { fs: disk, store, log };
}

const block = (rules: string = RULES): string => `${beginMarker(RULES_BLOCK)}\n${rulesBlockBody(rules)}\n${endMarker(RULES_BLOCK)}`;

suite('Tool rules in agents\' rule files', () => {

    // --- which file each agent reads ------------------------------------------------------

    test('the user files of Claude Code, Codex, Copilot CLI, Antigravity and Kimi Code are offered and preselected', () => {
        const offered = targets(new FakeDisk(), ['claude-code', 'codex', 'copilot-cli', 'antigravity', 'kimi-code'], { folders: [] });
        assert.deepStrictEqual(offered.map((target) => [target.file, target.scope, target.form, target.agents, target.preselect]), [
            [at(HOME, '.claude', 'CLAUDE.md'), 'user', 'block', ['claude-code'], true],
            [at(HOME, '.codex', 'AGENTS.md'), 'user', 'block', ['codex'], true],
            [at(HOME, '.copilot', 'copilot-instructions.md'), 'user', 'block', ['copilot-cli'], true],
            [at(HOME, '.gemini', 'AGENTS.md'), 'user', 'block', ['antigravity'], true],
            [at(HOME, '.kimi-code', 'AGENTS.md'), 'user', 'block', ['kimi-code'], true],
        ]);
    });

    test('CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME and KIMI_CODE_HOME move the user files', () => {
        const env = { CLAUDE_CONFIG_DIR: at(ROOT, 'claude'), CODEX_HOME: at(ROOT, 'codex'), COPILOT_HOME: at(ROOT, 'copilot'), KIMI_CODE_HOME: at(ROOT, 'kimi') };
        const files = targets(new FakeDisk(), ['claude-code', 'codex', 'copilot-cli', 'kimi-code'], { folders: [], env }).map((target) => target.file);
        assert.deepStrictEqual(files, [
            at(ROOT, 'claude', 'CLAUDE.md'), at(ROOT, 'codex', 'AGENTS.md'), at(ROOT, 'copilot', 'copilot-instructions.md'), at(ROOT, 'kimi', 'AGENTS.md'),
        ]);
    });

    test('Copilot Chat, Cursor, Cline and Roo Code get a workspace file only, and none is preselected', () => {
        const offered = targets(new FakeDisk(), ['copilot-chat', 'cursor', 'cline', 'roo']);
        assert.ok(offered.every((target) => target.scope === 'workspace' && !target.preselect));
        assert.deepStrictEqual(offered.map((target) => [path.relative(WS, target.file), target.form, target.agents]), [
            ['AGENTS.md', 'block', ['copilot-chat']],
            [at('.cursor', 'rules', 'cmsis-developer-assistant.mdc'), 'own', ['cursor']],
            [at('.clinerules', 'cmsis-developer-assistant.md'), 'own', ['cline']],
            [at('.roo', 'rules', 'cmsis-developer-assistant.md'), 'own', ['roo']],
        ]);
    });

    test('a workspace AGENTS.md that several agents read is one target naming them all', () => {
        const offered = targets(new FakeDisk(), ['codex', 'kimi-code', 'copilot-cli', 'copilot-chat', 'antigravity', 'claude-code'], { folders: [FOLDER] })
            .filter((target) => target.scope === 'workspace');
        assert.strictEqual(offered.length, 1);
        assert.strictEqual(offered[0].file, at(WS, 'AGENTS.md'));
        assert.deepStrictEqual(offered[0].agents, ['claude-code', 'codex', 'copilot-cli', 'antigravity', 'kimi-code', 'copilot-chat']);
    });

    test('Claude Code keeps to a project CLAUDE.md, and never creates one that would hide AGENTS.md', () => {
        const claudeIn = (disk: FakeDisk): string => path.relative(WS, targets(disk, ['claude-code']).find((target) => target.scope === 'workspace')!.file);
        assert.strictEqual(claudeIn(new FakeDisk()), 'AGENTS.md', 'no CLAUDE.md: the shared AGENTS.md, which Claude Code reads then');
        assert.strictEqual(claudeIn(new FakeDisk({ [at(WS, 'AGENTS.md')]: '# Team\n' })), 'AGENTS.md');
        assert.strictEqual(claudeIn(new FakeDisk({ [at(WS, 'CLAUDE.md')]: '# Mine\n' })), 'CLAUDE.md');
        assert.strictEqual(claudeIn(new FakeDisk({ [at(WS, '.claude', 'CLAUDE.md')]: '# Mine\n' })), at('.claude', 'CLAUDE.md'));
        assert.strictEqual(claudeIn(new FakeDisk({ [at(WS, 'CLAUDE.local.md')]: 'x' })), 'CLAUDE.md',
            'a CLAUDE.local.md already hides AGENTS.md from Claude Code');
    });

    test('Codex gets the override file it reads instead of AGENTS.md', () => {
        const disk = new FakeDisk({ [at(HOME, '.codex', 'AGENTS.override.md')]: 'Use tabs.\n', [at(WS, 'AGENTS.override.md')]: '  \n' });
        const files = targets(disk, ['codex']).map((target) => target.file);
        assert.deepStrictEqual(files, [at(HOME, '.codex', 'AGENTS.override.md'), at(WS, 'AGENTS.md')], 'an empty override is skipped by Codex');
    });

    test('Roo Code keeps to a .roorules it reads, and Cline moves to .cline/rules when .clinerules is a file', () => {
        const roo = targets(new FakeDisk({ [at(WS, '.roorules')]: 'Be brief.\n' }), ['roo'])[0];
        assert.deepStrictEqual([roo.file, roo.form], [at(WS, '.roorules'), 'block']);
        const rooWithDir = targets(new FakeDisk({ [at(WS, '.roorules')]: 'x', [at(WS, '.roo', 'rules', 'a.md')]: 'y' }), ['roo'])[0];
        assert.strictEqual(rooWithDir.file, at(WS, '.roo', 'rules', 'cmsis-developer-assistant.md'), '.roorules is not read while .roo/rules has files');
        const cline = targets(new FakeDisk({ [at(WS, '.clinerules')]: 'old single file' }), ['cline'])[0];
        assert.strictEqual(cline.file, at(WS, '.cline', 'rules', 'cmsis-developer-assistant.md'));
    });

    test('Copilot Chat uses .github/copilot-instructions.md while chat.useAgentsMdFile is off', () => {
        const chat = targets(new FakeDisk(), ['copilot-chat'], { copilotChatReadsAgentsMd: false })[0];
        assert.strictEqual(chat.file, at(WS, '.github', 'copilot-instructions.md'));
    });

    test('recorded files the agents no longer name are listed, a workspace one only while its folder is open', () => {
        const record = (file: string, scope: 'user' | 'workspace'): RuleFileRecord =>
            ({ file, scope, form: 'block', agents: ['codex'], created: false, createdDirs: [] });
        const listed = withRecordedTargets([], [
            record(at(HOME, '.codex', 'AGENTS.md'), 'user'),
            record(at(WS, 'AGENTS.md'), 'workspace'),
            record(at(ROOT, 'elsewhere', 'AGENTS.md'), 'workspace'),
        ], [FOLDER]);
        assert.deepStrictEqual(listed.map((target) => [target.file, target.folder?.name, target.preselect]), [
            [at(HOME, '.codex', 'AGENTS.md'), undefined, false],
            [at(WS, 'AGENTS.md'), 'blinky', false],
        ]);
    });

    test('records read back from globalState drop what is malformed', () => {
        const good: RuleFileRecord = { file: at(HOME, 'x.md'), scope: 'workspace', form: 'own', agents: ['cursor'], created: true, createdDirs: [at(HOME, 'd')] };
        assert.deepStrictEqual(parseRuleRecords([good, { file: '' }, 42, null, { file: at(HOME, 'y.md'), agents: ['ghost', 'codex'] }]), [
            good,
            { file: at(HOME, 'y.md'), scope: 'user', form: 'block', agents: ['codex'], created: false, createdDirs: [] },
        ]);
        assert.deepStrictEqual(parseRuleRecords(undefined), []);
    });

    // --- the block ---------------------------------------------------------------------------

    test('the block holds the provenance line, then the rules, and nothing outside it changes', () => {
        const mine = '# My notes\r\n\r\nUse tabs.\r\n';
        const withBlock = withRules(mine, at(WS, 'AGENTS.md'), RULES);
        assert.ok(withBlock.startsWith(mine), 'the text before the block is untouched');
        assert.ok(withBlock.includes(`\r\n${beginMarker(RULES_BLOCK)}\r\n${RULES_PROVENANCE}\r\n${RULES_HEADING}\r\n`), 'CRLF kept');
        assert.ok(RULES_PROVENANCE.includes('Managed by the CMSIS Developer Assistant extension; edits between these markers are replaced'));
        assert.strictEqual(rulesState(withBlock, RULES), 'current');
        assert.strictEqual(rulesState(withBlock, OLD_RULES), 'outdated');
        assert.strictEqual(rulesState(mine, RULES), 'absent');
        assert.strictEqual(rulesState(undefined, RULES), 'absent');
        assert.deepStrictEqual(withoutRules(withBlock, 'block'), { text: mine, empty: false });
        assert.strictEqual(withRules(withBlock, at(WS, 'AGENTS.md'), RULES), withBlock, 'a second write changes nothing');
    });

    test('a new Cursor rule file carries the frontmatter that makes it always apply', () => {
        const text = withRules(undefined, at(WS, '.cursor', 'rules', 'cmsis-developer-assistant.mdc'), RULES);
        assert.strictEqual(text, `---\ndescription: CMSIS Developer Assistant tool rules\nalwaysApply: true\n---\n\n${block()}\n`);
        assert.deepStrictEqual(withoutRules(text, 'own').empty, true, 'the frontmatter alone is no content of the user\'s');
    });

    // --- the step --------------------------------------------------------------------------------

    test('a declined preview writes nothing', async () => {
        const disk = new FakeDisk({ [at(HOME, '.codex', 'AGENTS.md')]: '# Mine\n' });
        const store = new MemoryStore();
        const user = scriptedUser(keepChecked, never);
        const report = await runRuleStep(targets(disk, ['claude-code', 'codex'], { folders: [] }), RULES, user, deps(disk, store));
        assert.deepStrictEqual(user.previewed.map((change) => [change.kind, change.target.file]), [
            ['create', at(HOME, '.claude', 'CLAUDE.md')],
            ['add', at(HOME, '.codex', 'AGENTS.md')],
        ]);
        assert.deepStrictEqual(report.declined, [at(HOME, '.claude', 'CLAUDE.md'), at(HOME, '.codex', 'AGENTS.md')]);
        assert.deepStrictEqual(disk.writes, []);
        assert.strictEqual(disk.files.get(at(HOME, '.codex', 'AGENTS.md')), '# Mine\n');
        assert.ok(!disk.dirs.has(at(HOME, '.claude')), 'not even the directory is made');
        assert.deepStrictEqual(store.records, []);
    });

    test('a dismissed picker changes nothing, and no preview is shown', async () => {
        const disk = new FakeDisk();
        const user = scriptedUser(() => undefined, always);
        const report = await runRuleStep(targets(disk, ['claude-code']), RULES, user, deps(disk, new MemoryStore()));
        assert.strictEqual(report.dismissed, true);
        assert.deepStrictEqual([user.previewed, disk.writes], [[], []]);
    });

    test('accepting writes the block, shows what is written first, and records the file', async () => {
        const disk = new FakeDisk({ [at(HOME, '.codex', 'AGENTS.md')]: '# Mine\n' }, [HOME]);
        const store = new MemoryStore();
        const user = scriptedUser(keepChecked, always);
        const report = await runRuleStep(targets(disk, ['claude-code', 'codex'], { folders: [] }), RULES, user, deps(disk, store));
        const claude = at(HOME, '.claude', 'CLAUDE.md');
        const codex = at(HOME, '.codex', 'AGENTS.md');
        assert.deepStrictEqual(report.applied, [{ file: claude, kind: 'create' }, { file: codex, kind: 'add' }]);
        assert.strictEqual(disk.files.get(claude), `${block()}\n`);
        assert.strictEqual(disk.files.get(codex), `# Mine\n\n${block()}\n`);
        assert.deepStrictEqual(user.previewed.map((change) => [change.before, change.after]), [
            [undefined, disk.files.get(claude)],
            ['# Mine\n', disk.files.get(codex)],
        ], 'the preview showed exactly what was written');
        assert.deepStrictEqual(store.records, [
            { file: claude, scope: 'user', form: 'block', agents: ['claude-code'], created: true, createdDirs: [at(HOME, '.claude')] },
            { file: codex, scope: 'user', form: 'block', agents: ['codex'], created: false, createdDirs: [] },
        ]);
    });

    test('a shared AGENTS.md is written once', async () => {
        const disk = new FakeDisk({ [at(WS, 'AGENTS.md')]: '# Team rules\n' });
        const store = new MemoryStore();
        const shared = at(WS, 'AGENTS.md');
        const user = scriptedUser(() => new Set([shared]), always);
        await runRuleStep(targets(disk, ['codex', 'copilot-cli', 'copilot-chat', 'antigravity']), RULES, user, deps(disk, store));
        assert.strictEqual(user.offered[0].filter((choice) => choice.target.file === shared).length, 1, 'offered once');
        assert.deepStrictEqual(user.previewed.map((change) => change.target.file), [shared], 'previewed once');
        assert.deepStrictEqual(disk.writes, [shared], 'written once');
        assert.strictEqual(disk.files.get(shared), `# Team rules\n\n${block()}\n`);
        assert.deepStrictEqual(store.records.map((record) => record.agents), [['codex', 'copilot-cli', 'antigravity', 'copilot-chat']]);
    });

    test('a file with the current rules is checked and needs no preview; an older block is updated', async () => {
        const current = at(HOME, '.claude', 'CLAUDE.md');
        const older = at(HOME, '.codex', 'AGENTS.md');
        const disk = new FakeDisk({ [current]: `# Mine\n\n${block()}\n`, [older]: `${block(OLD_RULES)}\n# After\n` });
        const user = scriptedUser(keepChecked, always);
        await runRuleStep(targets(disk, ['claude-code', 'codex'], { folders: [] }), RULES, user, deps(disk, new MemoryStore()));
        assert.deepStrictEqual(user.offered[0].map((choice) => [choice.state, choice.checked]), [['current', true], ['outdated', true]]);
        assert.deepStrictEqual(user.previewed.map((change) => change.kind), ['update']);
        assert.strictEqual(disk.files.get(older), `${block()}\n# After\n`);
        assert.deepStrictEqual(disk.writes, [older]);
    });

    test('taking the rules out leaves no residue', async () => {
        const kept = at(HOME, '.codex', 'AGENTS.md');
        const made = at(HOME, '.claude', 'CLAUDE.md');
        const cursor = at(WS, '.cursor', 'rules', 'cmsis-developer-assistant.mdc');
        const original = '# Mine\r\n\r\nUse tabs.\r\n';
        const disk = new FakeDisk({ [kept]: original }, [WS]);
        const store = new MemoryStore();
        const offered = targets(disk, ['claude-code', 'codex', 'cursor']);
        await runRuleStep(offered, RULES, scriptedUser(() => new Set([made, kept, cursor]), always), deps(disk, store));
        assert.deepStrictEqual([...disk.files.keys()].sort(), [cursor, made, kept].sort(), 'all three written');
        assert.ok(disk.dirs.has(at(WS, '.cursor', 'rules')));

        // Unchecking all three takes the rules out again.
        const user = scriptedUser(() => new Set(), always);
        const report = await runRuleStep(withRecordedTargets(targets(disk, ['claude-code', 'codex', 'cursor']), store.read(), [FOLDER]),
            RULES, user, deps(disk, store));
        assert.deepStrictEqual(user.previewed.map((change) => [change.kind, change.after === undefined]), [
            ['remove', true], ['remove', false], ['remove', true],
        ], 'the file made for the rules and the own file go; the user\'s file stays');
        assert.deepStrictEqual(report.applied.map((change) => change.kind), ['remove', 'remove', 'remove']);
        assert.strictEqual(disk.files.get(kept), original, 'the user\'s file is back to its bytes');
        assert.ok(!disk.files.has(made) && !disk.files.has(cursor));
        for (const dir of [at(HOME, '.claude'), at(WS, '.cursor', 'rules'), at(WS, '.cursor')]) {
            assert.ok(!disk.dirs.has(dir), `${dir} made for the rules is gone`);
        }
        assert.ok(disk.dirs.has(HOME) && disk.dirs.has(WS));
        assert.deepStrictEqual(store.records, [], 'nothing recorded any more');
    });

    test('a file made for the rules stays when the user added to it', async () => {
        const made = at(HOME, '.claude', 'CLAUDE.md');
        const disk = new FakeDisk({ [made]: `# Added later\n\n${block()}\n` });
        const store = new MemoryStore([{ file: made, scope: 'user', form: 'block', agents: ['claude-code'], created: true, createdDirs: [at(HOME, '.claude')] }]);
        await runRuleStep(targets(disk, ['claude-code'], { folders: [] }), RULES, scriptedUser(() => new Set(), always), deps(disk, store));
        assert.strictEqual(disk.files.get(made), '# Added later\n');
        assert.ok(disk.dirs.has(at(HOME, '.claude')));
    });

    test('a file whose markers are broken is not offered', async () => {
        const broken = at(HOME, '.claude', 'CLAUDE.md');
        const disk = new FakeDisk({ [broken]: `${beginMarker(RULES_BLOCK)}\nhalf a block\n` });
        const log = keptLog();
        const user = scriptedUser(keepChecked, always);
        await runRuleStep(targets(disk, ['claude-code', 'codex'], { folders: [] }), RULES, user, deps(disk, new MemoryStore(), log));
        assert.deepStrictEqual(user.offered[0].map((choice) => choice.target.file), [at(HOME, '.codex', 'AGENTS.md')]);
        assert.ok(log.lines.some((line) => line.startsWith('WARN') && line.includes(broken)));
    });

    // --- activation --------------------------------------------------------------------------------

    /** A stale, a current, a gone and an emptied record, and a stale file nobody recorded. */
    function activationDisk(): {
        disk: FakeDisk; store: MemoryStore; stale: string; current: string; gone: string; blockDeleted: string; notOurs: string;
        around: (inner: string) => string;
    } {
        const stale = at(HOME, '.codex', 'AGENTS.md');
        const current = at(HOME, '.claude', 'CLAUDE.md');
        const gone = at(HOME, '.copilot', 'copilot-instructions.md');
        const blockDeleted = at(WS, 'AGENTS.md');
        const notOurs = at(HOME, '.gemini', 'AGENTS.md');
        const around = (inner: string): string => `# Before\r\n\r\n${inner.replace(/\n/g, '\r\n')}\r\n\r\n# After\r\n`;
        const disk = new FakeDisk({
            [stale]: around(block(OLD_RULES)),
            [current]: `${block()}\n`,
            [blockDeleted]: '# The user took the block out\n',
            [notOurs]: `${block(OLD_RULES)}\n`,
        });
        const record = (file: string): RuleFileRecord => ({ file, scope: 'user', form: 'block', agents: ['codex'], created: false, createdDirs: [] });
        const store = new MemoryStore([record(stale), record(current), record(gone), record(blockDeleted)]);
        return { disk, store, stale, current, gone, blockDeleted, notOurs, around };
    }

    test('activation updates a recorded, stale block in place after review and confirmation, and never creates one', async () => {
        const { disk, store, stale, current, gone, blockDeleted, notOurs, around } = activationDisk();
        const log = keptLog();
        const user = refreshUser(true, always);
        const report = await refreshRecordedRules(RULES, user, deps(disk, store, log));
        assert.deepStrictEqual(report, { updated: [stale], postponed: [], forgotten: [gone, blockDeleted], failed: [] });
        assert.deepStrictEqual(user.offers.map((changes) => changes.map((change) => [change.target.file, change.kind])), [[[stale, 'update']]],
            'one offer, for the stale block only');
        assert.strictEqual(user.previewed[0].after, around(block()), 'the preview shows the updated file');
        assert.strictEqual(disk.files.get(stale), around(block()), 'updated in place; the text around it and CRLF stay');
        assert.deepStrictEqual(disk.writes, [stale], 'only the stale block is written');
        assert.ok(!disk.files.has(gone), 'a missing file is not created');
        assert.strictEqual(disk.files.get(blockDeleted), '# The user took the block out\n', 'a deleted block is not written back');
        assert.strictEqual(disk.files.get(notOurs), `${block(OLD_RULES)}\n`, 'an unrecorded file is not touched');
        assert.deepStrictEqual(store.records.map((kept) => kept.file).sort(), [current, stale].sort());
        assert.ok(log.lines.some((line) => line.includes(stale) && line.includes('updated')), 'the update is logged');
    });

    test('activation writes nothing when the review is not taken up or the update is declined', async () => {
        for (const [review, confirm] of [[false, always], [true, never]] as const) {
            const { disk, store, stale, current, gone, blockDeleted, around } = activationDisk();
            const log = keptLog();
            const user = refreshUser(review, confirm);
            const report = await refreshRecordedRules(RULES, user, deps(disk, store, log));
            assert.deepStrictEqual(report, { updated: [], postponed: [stale], forgotten: [gone, blockDeleted], failed: [] });
            assert.strictEqual(user.previewed.length, review ? 1 : 0, 'a preview only after Review');
            assert.deepStrictEqual(disk.writes, [], 'no file is written');
            assert.strictEqual(disk.files.get(stale), around(block(OLD_RULES)), 'the stale block stays');
            assert.deepStrictEqual(store.records.map((kept) => kept.file), [stale, current], 'the stale record is kept for the setup step');
        }
    });

    test('activation does not ask while every recorded block is current', async () => {
        const current = at(HOME, '.claude', 'CLAUDE.md');
        const disk = new FakeDisk({ [current]: `${block()}\n` });
        const store = new MemoryStore([{ file: current, scope: 'user', form: 'block', agents: ['claude-code'], created: false, createdDirs: [] }]);
        const user = refreshUser(true, always);
        const report = await refreshRecordedRules(RULES, user, deps(disk, store));
        assert.deepStrictEqual(report, { updated: [], postponed: [], forgotten: [], failed: [] });
        assert.deepStrictEqual(user.offers, [], 'no offer');
        assert.deepStrictEqual(disk.writes, []);
    });

    test('a block the user deletes while the update is offered is not written back', async () => {
        const { disk, store, stale, around } = activationDisk();
        const user = refreshUser(true, always);
        const offer = user.offer;
        user.offer = async (changes) => {
            disk.files.set(stale, around('# The block is gone'));
            return offer(changes);
        };
        const report = await refreshRecordedRules(RULES, user, deps(disk, store));
        assert.deepStrictEqual(report.updated, []);
        assert.deepStrictEqual(report.postponed, [stale]);
        assert.deepStrictEqual(disk.writes, [], 'nothing is written');
    });
});
