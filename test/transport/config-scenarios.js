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

// Configuration scenario oracle.
//
// Records, from the outside, what three modules do:
//
// - `utils/agentConfigurationManager`: the agent config files it writes (full
//   contents), the setup flow's pickers and toasts with the answers scripted
//   here, globalState and settings writes, and the skill-sync calls.
// - `utils/debugConfigurationManager`: the launch configurations it builds,
//   how it reads `.vscode/launch.json`, and its configuration quick-pick.
// - `extension`: activate() and deactivate() under the stub — the order of
//   the major calls, the settings read, the registered commands, the MCP
//   server definition provider, the listeners, the setup timer, and the
//   Serial Monitor's API as the window's bridge gets it when the coordinator
//   starts.
//
// Only public entry points are driven; private methods are never called, so
// the same script runs against a rewrite of any of the three files.
//
//   node test/transport/config-scenarios.js              compare with the snapshot
//   node test/transport/config-scenarios.js --update     rewrite the snapshot
//   node test/transport/config-scenarios.js --only <id>  print matching scenarios, no compare
//   node test/transport/config-scenarios.js --check-fence  self-test of the isolation below
//   add --verbose to print the extension log lines of every scenario that ran
//
// Isolation. Everything the code can derive a path from — HOME, USERPROFILE,
// APPDATA, LOCALAPPDATA, XDG_*, CODEX_HOME, COPILOT_HOME, CLAUDE_CONFIG_DIR,
// GEMINI_HOME, KIMI_CODE_HOME, CMSIS_PACK_ROOT, TMPDIR/TMP/TEMP, os.homedir(), os.tmpdir(),
// the context's extensionPath and globalStorageUri — points into one fresh
// temporary directory. That is asserted before every scenario, and a write
// fence on `fs` refuses and reports any write outside it. Sockets: 127.0.0.1
// listeners on ephemeral ports only; nothing reaches the network.
//
// A refactoring that is meant to change no behaviour must leave the snapshot
// byte-identical. A deliberate change updates it in the same commit.

'use strict';

const stub = require('./vscode-stub.js');

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'out', 'src');
const SNAPSHOT = path.join(__dirname, 'config-scenarios.snapshot.json');
const SCENARIO_TIMEOUT_MS = 20_000;
/** A fixed epoch for globalState values of earlier releases. */
const FIXED_NOW = 1_700_000_000_000;
const FIXTURE_VERSION = '0.0.0-fixture';

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const VERBOSE = argv.includes('--verbose');
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;

// ===========================================================================
// Sandbox
// ===========================================================================

const REAL_TMPDIR = os.tmpdir();
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(REAL_TMPDIR, 'cda-config-scenarios-')));
const TMP = path.join(ROOT, 'tmp');          // TMPDIR of the code under test (window registry)
const EXT = path.join(ROOT, 'extension');    // fixture extensionPath with a small skill catalog
const WORLDS = path.join(ROOT, 'worlds');    // one home per scenario
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(WORLDS, { recursive: true });

/** Variables that can steer a path; all are reset for every scenario. */
const CONTROLLED_ENV = [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'CODEX_HOME', 'COPILOT_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_HOME', 'KIMI_CODE_HOME', 'ANTIGRAVITY_ENV', 'CMSIS_PACK_ROOT',
    'TMPDIR', 'TMP', 'TEMP',
];
const PATH_ENV = CONTROLLED_ENV.filter((k) => k !== 'ANTIGRAVITY_ENV');

function isInside(p, dir) {
    const r = path.resolve(p);
    return r === dir || r.startsWith(dir + path.sep);
}

for (const k of CONTROLLED_ENV) { delete process.env[k]; }
process.env.HOME = path.join(ROOT, 'no-world');
process.env.USERPROFILE = process.env.HOME;
process.env.TMPDIR = TMP;
process.env.TMP = TMP;
process.env.TEMP = TMP;

/** The scenario's home; set by enterWorld. */
let world = null;
const realPlatform = os.platform;
os.homedir = () => (world ? world.home : path.join(ROOT, 'no-world'));

// --- write fence -----------------------------------------------------------

const violations = [];
let fenceOn = false;

function toPath(p) {
    if (typeof p === 'string') { return p; }
    if (Buffer.isBuffer(p)) { return p.toString(); }
    if (p instanceof URL) { return fileURLToPath(p); }
    return undefined;
}

function guard(op, p) {
    const s = toPath(p);
    if (!fenceOn || s === undefined || isInside(s, ROOT)) { return; }
    violations.push(`${op} ${path.resolve(s)}`);
    const err = new Error(`EACCES: config-scenarios refused a write outside its sandbox (${op} ${s})`);
    err.code = 'EACCES';
    throw err;
}

/** Operation → indices of the arguments it writes or removes. */
const WRITE_OPS = {
    writeFile: [0], appendFile: [0], mkdir: [0], rm: [0], rmdir: [0], unlink: [0], truncate: [0],
    mkdtemp: [0], utimes: [0], lutimes: [0], chmod: [0], chown: [0], lchown: [0],
    rename: [0, 1], copyFile: [1], cp: [1], symlink: [1], link: [1],
};

function isWriteFlag(flags) {
    if (typeof flags === 'string') { return /[wa+]/.test(flags); }
    if (typeof flags === 'number') {
        const c = fs.constants;
        return (flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_TRUNC)) !== 0;
    }
    return false;
}

function fence(obj, key, kind, op, check) {
    const orig = obj[key];
    if (typeof orig !== 'function') { return; }
    obj[key] = function (...args) {
        try {
            check(args);
        } catch (err) {
            if (kind === 'promise') { return Promise.reject(err); }
            if (kind === 'callback') {
                const cb = [...args].reverse().find((a) => typeof a === 'function');
                if (cb) { process.nextTick(cb, err); return undefined; }
            }
            throw err;
        }
        if (kind === 'sync') {
            const r = orig.apply(this, args);
            fsEvent(op, args[0], args[1]);
            return r;
        }
        if (kind === 'promise') {
            return orig.apply(this, args).then((r) => { fsEvent(op, args[0], args[1]); return r; });
        }
        return orig.apply(this, args);
    };
}

function installFence() {
    for (const [op, idxs] of Object.entries(WRITE_OPS)) {
        const check = (args) => { for (const i of idxs) { guard(op, args[i]); } };
        fence(fs, `${op}Sync`, 'sync', op, check);
        fence(fs, op, 'callback', op, check);
        fence(fs.promises, op, 'promise', op, check);
    }
    const openCheck = (args) => { if (isWriteFlag(args[1])) { guard('open', args[0]); } };
    fence(fs, 'openSync', 'sync', 'open', openCheck);
    fence(fs, 'open', 'callback', 'open', openCheck);
    fence(fs.promises, 'open', 'promise', 'open', openCheck);
    fence(fs, 'createWriteStream', 'sync', 'createWriteStream', (args) => guard('createWriteStream', args[0]));
    // A scenario can make a file look as if another process rewrote it
    // between two reads (S.ui.onRead); nothing is written by this.
    const realReadFile = fs.promises.readFile;
    fs.promises.readFile = function (p, ...rest) {
        const s = toPath(p);
        const alt = S.ui.onRead && s !== undefined ? S.ui.onRead(path.resolve(s)) : undefined;
        return alt !== undefined ? Promise.resolve(alt) : realReadFile.call(this, p, ...rest);
    };
    fenceOn = true;
}

/** File writes the code makes in the scenario's home, in call order (skill trees and the registry excluded). */
function fsEvent(op, a, b) {
    if (!S.log || !world) { return; }
    const pa = toPath(a);
    const pb = toPath(b);
    const relevant = (p) => !!p && isInside(p, world.root) && !path.resolve(p).split(path.sep).includes('skills');
    if (op === 'rename') {
        if (!relevant(pb)) { return; }
        const atomic = path.dirname(pa) === path.dirname(pb) && path.basename(pa).startsWith(`${path.basename(pb)}.`) && pa.endsWith('.tmp');
        emit(atomic ? { ev: 'write', path: pb, atomic: true } : { ev: 'rename', from: pa, to: pb });
        return;
    }
    if (!relevant(pa) || pa.endsWith('.tmp')) { return; }
    if (op === 'writeFile' || op === 'appendFile') {
        emit({ ev: 'write', path: pa, atomic: false, ...(op === 'appendFile' ? { append: true } : {}) });
    } else if (op === 'unlink' || op === 'rm' || op === 'rmdir') {
        emit({ ev: 'remove', path: pa });
    }
}

// ===========================================================================
// Scenario state and recording
// ===========================================================================

function newState() {
    return {
        log: null,
        settings: { global: new Map(), workspace: new Map(), folders: new Map() },
        globalState: new Map(),
        folders: [],
        workspaceFile: undefined,
        ui: {},
        listeners: new Map(),
        commands: new Map(),
        providers: [],
        reads: null,
        openOverrides: new Map(),
        timers: [],
        captureTimers: false,
        syncCount: 0,
        context: undefined,
        packDocs: undefined,
        failStart: false,
        contentProviders: new Map(),
    };
}

let S = newState();
const PORTS = new Set();
const LOG_LINES = [];

function emit(ev) {
    if (S.log) { S.log.push(ev); }
}

function step(name) {
    emit({ ev: 'step', name });
}

/** `undefined` made visible in JSON. */
function u(v) {
    return v === undefined ? '<undefined>' : v;
}

/** Deep copy for the record: undefined → '<undefined>', functions and Uris named. */
function explicit(v) {
    if (v === undefined) { return '<undefined>'; }
    if (typeof v === 'function') { return '<function>'; }
    if (v && typeof v === 'object') {
        if (typeof v.scheme === 'string' && typeof v.toString === 'function' && 'fsPath' in v) { return `<uri ${v.toString()}>`; }
        if (Array.isArray(v)) { return v.map(explicit); }
        const o = {};
        for (const [k, x] of Object.entries(v)) { o[k] = explicit(x); }
        return o;
    }
    return v;
}

function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function describeError(e) {
    if (e instanceof Error) { return `${e.name}: ${e.message}`; }
    return `<non-error> ${String(e)}`;
}

/** Answer value from a script entry: a function (called), else the constant. */
function val(entry, ...args) {
    return typeof entry === 'function' ? entry(...args) : entry;
}

/** Successive answers; the last one repeats. */
function seq(...values) {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}

// ===========================================================================
// vscode stub, extended in this process only
// ===========================================================================

const QuickPickItemKind = { Separator: -1, Default: 0 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const TARGET_NAMES = new Map([[1, 'Global'], [2, 'Workspace'], [3, 'WorkspaceFolder'], [true, 'Global'], [false, 'Workspace'], [undefined, '<default>'], [null, '<default>']]);

function fileUri(p) {
    return {
        scheme: 'file', authority: '', path: p.split(path.sep).join('/'), fsPath: p, query: '', fragment: '',
        toString() { return `file://${this.path}`; },
        toJSON() { return this.toString(); },
    };
}

function parseUri(s) {
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(s) ?? [];
    return {
        scheme: m[1] ?? '', authority: m[2] ?? '', path: m[3] ?? '', query: m[4] ?? '', fragment: m[5] ?? '',
        fsPath: m[3] ?? '',
        toString() { return s; },
        toJSON() { return s; },
    };
}

function joinPath(base, ...segments) {
    if (base.scheme === 'file') { return fileUri(path.join(base.fsPath, ...segments)); }
    return parseUri(`${base.scheme}://${base.authority}${path.posix.join(base.path, ...segments)}`);
}

function disposable(label) {
    return { label, dispose() {} };
}

function event(name) {
    return (listener, thisArg, disposables) => {
        emit({ ev: 'subscribe', event: name });
        const list = S.listeners.get(name) ?? [];
        list.push(thisArg ? listener.bind(thisArg) : listener);
        S.listeners.set(name, list);
        const d = disposable(`event:${name}`);
        if (Array.isArray(disposables)) { disposables.push(d); }
        return d;
    };
}

/** Deliver an event to every listener and wait for the async ones. Returns listener failures. */
async function fire(name, arg) {
    const results = (S.listeners.get(name) ?? []).map((l) => {
        try { return l(arg); } catch (e) { return Promise.reject(e); }
    });
    const settled = await Promise.allSettled(results);
    return settled.filter((r) => r.status === 'rejected').map((r) => describeError(r.reason));
}

// --- settings ----------------------------------------------------------------

function scopePathOf(scope) {
    if (!scope) { return undefined; }
    if (typeof scope.fsPath === 'string') { return scope.fsPath; }
    if (scope.uri && typeof scope.uri.fsPath === 'string') { return scope.uri.fsPath; }
    return undefined;
}

function getConfiguration(section, scope) {
    const scopePath = scopePathOf(scope);
    const full = (key) => (section ? `${section}.${key}` : key);
    const lookup = (k) => {
        const folder = scopePath !== undefined ? S.settings.folders.get(scopePath) : undefined;
        if (folder && folder.has(k)) { return folder.get(k); }
        if (S.settings.workspace.has(k)) { return S.settings.workspace.get(k); }
        if (S.settings.global.has(k)) { return S.settings.global.get(k); }
        return undefined;
    };
    const noteRead = (k, how) => {
        if (S.reads) { S.reads.set(`${k}|${how}`, { key: k, ...how === 'inspect' ? { inspect: true } : { fallback: JSON.parse(how) } }); }
    };
    return {
        get(key, fallback) {
            const k = full(key);
            noteRead(k, JSON.stringify(explicit(fallback)));
            const v = lookup(k);
            return v === undefined ? fallback : clone(v);
        },
        has(key) { return lookup(full(key)) !== undefined; },
        inspect(key) {
            const k = full(key);
            noteRead(k, 'inspect');
            const folder = scopePath !== undefined ? S.settings.folders.get(scopePath) : undefined;
            return {
                key: k,
                defaultValue: undefined,
                globalValue: clone(S.settings.global.get(k)),
                workspaceValue: clone(S.settings.workspace.get(k)),
                workspaceFolderValue: clone(folder?.get(k)),
            };
        },
        update(key, value, target) {
            const k = full(key);
            const targetName = TARGET_NAMES.get(target) ?? String(target);
            emit({ ev: 'setting', key: k, value: u(clone(value)), target: targetName, ...(scopePath !== undefined ? { scope: scopePath } : {}) });
            let store;
            if (targetName === 'Global') {
                store = S.settings.global;
            } else if (targetName === 'WorkspaceFolder') {
                if (scopePath === undefined) {
                    return Promise.reject(new Error('Unable to write to Folder Settings because no resource is provided.'));
                }
                store = S.settings.folders.get(scopePath) ?? new Map();
                S.settings.folders.set(scopePath, store);
            } else {
                store = S.settings.workspace;
            }
            if (value === undefined) { store.delete(k); } else { store.set(k, clone(value)); }
            return Promise.resolve();
        },
    };
}

// --- window ----------------------------------------------------------------

function itemTitle(item) {
    return typeof item === 'string' ? item : item?.title;
}

function messageFn(kind) {
    return (message, ...rest) => {
        let options;
        if (rest.length > 0 && rest[0] && typeof rest[0] === 'object' && !('title' in rest[0])) { options = rest.shift(); }
        const items = rest;
        const answer = val(S.ui.message, { kind, message, items: items.map(itemTitle) });
        const chosen = typeof answer === 'number' ? items[answer] : undefined;
        emit({
            ev: kind, message,
            ...(options ? { options: explicit(options) } : {}),
            ...(items.length > 0 ? { items: items.map(itemTitle), answer: chosen === undefined ? '<dismissed>' : itemTitle(chosen) } : {}),
        });
        return Promise.resolve(chosen);
    };
}

function normItem(item) {
    const o = {};
    if (item.kind === QuickPickItemKind.Separator) { o.kind = 'separator'; }
    for (const k of ['label', 'description', 'detail', 'picked', 'alwaysShow']) {
        if (item[k] !== undefined) { o[k] = item[k]; }
    }
    return o;
}

function pickOptions(options) {
    const o = {};
    for (const k of ['title', 'placeHolder', 'ignoreFocusOut', 'canPickMany', 'matchOnDescription', 'matchOnDetail']) {
        if (options && options[k] !== undefined) { o[k] = options[k]; }
    }
    return o;
}


/** What the scripted user does with a createQuickPick picker. */
function decideQuickPick(state) {
    const title = state.title ?? '';
    if (/AI Agents/i.test(title)) {
        const a = val(S.ui.agents);
        if (a === null || a === undefined) { return null; }
        return { accept: (it) => a === 'all' || a.includes(it.detail) };
    }
    if (/Rule Files/i.test(title)) {
        // 'keep' accepts the checks as the picker opens; a list keeps the items whose label contains one of its strings.
        const r = val(S.ui.rules);
        if (r === null || r === undefined) { return null; }
        if (r === 'keep') { return { keep: true }; }
        return { accept: (it) => r.some((needle) => it.label.includes(needle)) };
    }
    return null;
}

/** What the scripted user picks in a showQuickPick; an index or undefined. */
function decidePick(items, options) {
    if (S.ui.pick) { return S.ui.pick(items, options); }
    return undefined;
}

async function showQuickPick(items, options) {
    const list = await items;
    const answer = decidePick(list.map(normItem), options);
    const chosen = typeof answer === 'number' ? list[answer] : undefined;
    emit({ ev: 'showQuickPick', options: pickOptions(options), items: list.map(normItem), answer: chosen ? chosen.label : '<dismissed>' });
    return chosen;
}

function createQuickPick() {
    emit({ ev: 'createQuickPick' });
    if (S.ui.quickPickThrows) { throw new Error('quick input is unavailable (scripted)'); }
    const accept = [];
    const hide = [];
    let visible = false;
    let record = null;          // the 'quickPick' event, once shown
    let disposed = false;
    const qp = {
        title: undefined, placeholder: undefined, items: [], selectedItems: [], activeItems: [], value: '',
        canSelectMany: false, ignoreFocusOut: false, matchOnDescription: false, matchOnDetail: false,
        busy: false, enabled: true, buttons: [], step: undefined, totalSteps: undefined,
        onDidAccept: (l) => { accept.push(l); return disposable('quickPick.onDidAccept'); },
        onDidHide: (l) => { hide.push(l); return disposable('quickPick.onDidHide'); },
        onDidChangeSelection: () => disposable('quickPick.onDidChangeSelection'),
        onDidChangeActive: () => disposable('quickPick.onDidChangeActive'),
        onDidChangeValue: () => disposable('quickPick.onDidChangeValue'),
        onDidTriggerButton: () => disposable('quickPick.onDidTriggerButton'),
        onDidTriggerItemButton: () => disposable('quickPick.onDidTriggerItemButton'),
        show() {
            if (visible) { return; }
            visible = true;
            setImmediate(act);
        },
        // In the extension host onDidHide arrives asynchronously, after hide() returns.
        hide() {
            if (!visible) { return; }
            visible = false;
            setImmediate(() => hide.forEach((l) => l()));
        },
        // Recorded as a flag on the picker's event, not as an event: when it
        // happens relative to the file writes is not behaviour.
        dispose() { disposed = true; if (record) { record.disposed = true; } },
    };
    function act() {
        const state = {
            title: qp.title, placeholder: qp.placeholder,
            canSelectMany: qp.canSelectMany, ignoreFocusOut: qp.ignoreFocusOut,
            matchOnDescription: qp.matchOnDescription, matchOnDetail: qp.matchOnDetail,
            items: qp.items.map(normItem),
            selected: qp.selectedItems.map((i) => i.label),
        };
        const decision = decideQuickPick(state);
        const ev = { ev: 'quickPick', ...state };
        record = ev;
        if (disposed) { ev.disposed = true; }
        emit(ev);
        if (decision && (decision.accept || decision.keep)) {
            const chosen = decision.keep
                ? qp.selectedItems
                : qp.items.filter((i) => i.kind !== QuickPickItemKind.Separator && decision.accept(i));
            qp.selectedItems = chosen;
            ev.action = 'accept';
            ev.chosen = chosen.map((i) => i.label);
            accept.forEach((l) => l());
        } else {
            ev.action = 'dismiss';
            visible = false;
            hide.forEach((l) => l());
        }
    }
    return qp;
}

/** The text a diff side shows: a virtual document through its content provider, a file from the disk. */
function documentText(uri) {
    const provider = uri && S.contentProviders.get(uri.scheme);
    if (provider) { return provider.provideTextDocumentContent(uri); }
    if (uri && uri.scheme === 'file') {
        try { return fs.readFileSync(uri.fsPath, 'utf8'); } catch { return '<no file>'; }
    }
    return '<unknown document>';
}

/**
 * A status-bar item that records being made, shown and disposed. What it
 * shows at `show()` is recorded too; later text and tooltip changes are
 * not, since the tooltip carries times.
 */
function createStatusBarItem(id, alignment, priority) {
    emit({ ev: 'createStatusBarItem', id, alignment, priority });
    const item = {
        label: `statusBarItem:${id}`, id, alignment, priority, name: undefined, text: '', tooltip: undefined, command: undefined,
        show() { emit({ ev: 'statusBarItem.show', id, name: item.name, command: item.command, text: item.text }); },
        hide() { emit({ ev: 'statusBarItem.hide', id }); },
        dispose() { emit({ ev: 'statusBarItem.dispose', id }); },
    };
    return item;
}

// --- the API object ------------------------------------------------------------

const api = {
    version: '1.109.0',
    Uri: { file: fileUri, parse: parseUri, joinPath },
    QuickPickItemKind,
    ConfigurationTarget,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    Disposable: class Disposable {
        constructor(fn) { this.fn = fn; this.label = 'Disposable'; }
        dispose() { this.fn?.(); }
        static from(...ds) { return new Disposable(() => ds.forEach((d) => d.dispose())); }
    },
    McpHttpServerDefinition: class McpHttpServerDefinition {
        constructor(label, uri, headers, version) { Object.assign(this, { label, uri, headers, version }); }
    },
    window: {
        activeTextEditor: undefined,
        showInformationMessage: messageFn('info'),
        showWarningMessage: messageFn('warning'),
        showErrorMessage: messageFn('error'),
        showQuickPick,
        createQuickPick,
        createStatusBarItem,
        showInputBox: async (options) => { emit({ ev: 'showInputBox', options: explicit(options) }); return undefined; },
        showOpenDialog: async (options) => { emit({ ev: 'showOpenDialog', options: explicit(options) }); return undefined; },
        withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable('cancel') }),
        createOutputChannel: (name) => {
            const line = (level) => (...a) => LOG_LINES.push(`[${S.id ?? '-'}] ${level} ${a.map(String).join(' ')}`);
            return {
                label: 'outputChannel', name,
                appendLine: line('line'), append: line('text'), replace() {}, clear() {}, show() {}, hide() {}, dispose() {},
                trace: line('trace'), debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error'),
            };
        },
        createWebviewPanel: () => { throw new Error('createWebviewPanel is not stubbed'); },
    },
    workspace: {
        get workspaceFolders() { return S.folders.length > 0 ? S.folders : undefined; },
        get workspaceFile() { return S.workspaceFile; },
        get name() { return S.folders.length > 0 ? 'fixture-workspace' : undefined; },
        getConfiguration,
        getWorkspaceFolder(uri) {
            return S.folders.find((f) => isInside(uri.fsPath, f.uri.fsPath));
        },
        onDidChangeConfiguration: event('workspace.onDidChangeConfiguration'),
        onDidChangeWorkspaceFolders: event('workspace.onDidChangeWorkspaceFolders'),
        registerTextDocumentContentProvider(scheme, provider) {
            emit({ ev: 'registerTextDocumentContentProvider', scheme });
            S.contentProviders.set(scheme, provider);
            return disposable(`textDocumentContentProvider:${scheme}`);
        },
        async openTextDocument(target) {
            const p = typeof target === 'string' ? target : target.fsPath;
            let text;
            if (S.openOverrides.has(p)) {
                text = S.openOverrides.get(p);
            } else {
                try {
                    text = fs.readFileSync(p, 'utf8');
                } catch {
                    throw new Error(`cannot open file://${p}. Detail: Unable to read file '${p}'`);
                }
            }
            return { uri: fileUri(p), fileName: p, isDirty: S.openOverrides.has(p), getText: () => text };
        },
        findFiles: async () => [],
    },
    commands: {
        registerCommand(id, handler) {
            emit({ ev: 'registerCommand', id });
            S.commands.set(id, handler);
            return disposable(`command:${id}`);
        },
        async executeCommand(id, ...args) {
            const ev = { ev: 'executeCommand', id, args: args.map(explicit) };
            if (id === 'vscode.diff') { ev.shows = args.slice(0, 2).map(documentText); }
            emit(ev);
            return val(S.ui.command, id, args);
        },
        getCommands: async () => [...S.commands.keys()],
    },
    debug: {
        ...stub.debug,
        registerDebugAdapterTrackerFactory(type) {
            emit({ ev: 'registerDebugAdapterTrackerFactory', type });
            return disposable(`debugAdapterTrackerFactory:${type}`);
        },
        onDidStartDebugSession: event('debug.onDidStartDebugSession'),
        onDidTerminateDebugSession: event('debug.onDidTerminateDebugSession'),
        onDidChangeActiveDebugSession: event('debug.onDidChangeActiveDebugSession'),
        onDidChangeActiveStackItem: event('debug.onDidChangeActiveStackItem'),
        onDidChangeBreakpoints: event('debug.onDidChangeBreakpoints'),
        startDebugging: async () => false,
        stopDebugging: async () => undefined,
    },
    extensions: {
        getExtension(id) {
            emit({ ev: 'getExtension', id });
            return val(S.ui.extension, id);
        },
        onDidChange: event('extensions.onDidChange'),
        all: [],
    },
    lm: {
        registerMcpServerDefinitionProvider(id, provider) {
            emit({ ev: 'registerMcpServerDefinitionProvider', id });
            S.providers.push({ id, provider });
            return disposable(`mcpServerDefinitionProvider:${id}`);
        },
    },
    env: {
        appName: 'Visual Studio Code (config-scenarios stub)',
        uriScheme: 'vscode',
        openExternal: async (uri) => { emit({ ev: 'openExternal', uri: String(uri) }); return false; },
    },
    tasks: {
        onDidStartTaskProcess: event('tasks.onDidStartTaskProcess'),
        onDidEndTaskProcess: event('tasks.onDidEndTaskProcess'),
        executeTask: async () => { throw new Error('tasks are not stubbed'); },
    },
};

// Every top-level key must exist before the first `require` of an out/ module:
// the compiled `import * as vscode` binds the keys present at that moment.
Object.assign(stub, api);

// --- the 2 s setup timer -----------------------------------------------------------

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
global.setTimeout = function (fn, ms, ...args) {
    if (S.captureTimers && ms === 2000 && /[\\/]extension\.js:\d+/.test(new Error().stack ?? '')) {
        const handle = { captured: true, ref() { return this; }, unref() { return this; }, hasRef() { return false; }, refresh() { return this; } };
        S.timers.push({ fn, args, ms, handle });
        emit({ ev: 'setTimeout', ms });
        return handle;
    }
    return realSetTimeout.call(this, fn, ms, ...args);
};
global.clearTimeout = function (handle) {
    if (handle && handle.captured) {
        handle.cleared = true;
        emit({ ev: 'clearTimeout', ms: 2000 });
        return undefined;
    }
    return realClearTimeout.call(this, handle);
};

// ===========================================================================
// Worlds (one sandboxed home per scenario)
// ===========================================================================

/** darwin roster paths (spec table) relative to the world root. */
const AGENT_FILES = {
    'roo': 'home/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
    'antigravity': 'home/.gemini/antigravity/mcp_config.json',
    'cline': 'home/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
    'copilot-cli': 'home/.copilot/mcp-config.json',
    'cursor': 'home/.cursor/mcp.json',
    'codex': 'home/.codex/config.toml',
    'kimi-code': 'home/.kimi-code/mcp.json',
    'claude-code': 'home/.claude.json',
    'claude-desktop': 'home/Library/Application Support/Claude/claude_desktop_config.json',
};

/** Where releases before 2.5.1 wrote Cursor's entry (darwin), a file Cursor does not read. */
const OLD_CURSOR_FILE = 'home/Library/Application Support/Cursor/User/globalStorage/cursor.mcp/settings/mcp_settings.json';

function agentSeeds(byAgent) {
    const out = {};
    for (const [id, content] of Object.entries(byAgent)) { out[AGENT_FILES[id]] = content; }
    return out;
}

let helpers = null;   // pure path helpers of unchanged collaborators, for the isolation check

function assertIsolated() {
    const problems = isolationProblems();
    if (problems.length > 0) {
        abort(`ISOLATION CHECK FAILED — nothing was run against these paths:\n  ${problems.join('\n  ')}`);
    }
}

function isolationProblems() {
    const problems = [];
    const check = (label, p) => { if (p && !isInside(p, ROOT)) { problems.push(`${label} = ${p}`); } };
    check('os.homedir()', os.homedir());
    check('os.tmpdir()', os.tmpdir());
    for (const k of PATH_ENV) {
        if (process.env[k]) { check(`$${k}`, process.env[k]); }
    }
    check('window registry directory', path.join(os.tmpdir(), 'cmsis-developer-assistant-registry'));
    if (helpers) {
        const roots = helpers.getSkillInstallRoots();
        for (const r of [...roots.install, ...roots.sweepOnly]) { check('user skill root', r); }
        check('default pack root', helpers.defaultPackRoot());
        check('user docs directory', helpers.resolveUserDocsDir(''));
    }
    return problems;
}

function enterWorld(def) {
    const root = path.join(WORLDS, def.id);
    fs.mkdirSync(root, { recursive: true });
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    for (const k of CONTROLLED_ENV) { delete process.env[k]; }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.TMPDIR = TMP;
    process.env.TMP = TMP;
    process.env.TEMP = TMP;
    for (const [k, v] of Object.entries(def.env ?? {})) {
        if (v === null) { delete process.env[k]; } else { process.env[k] = v.replace('<w>', root); }
    }
    world = { id: def.id, root, home, platform: def.platform ?? 'darwin' };
    os.platform = () => world.platform;
    assertIsolated();
    return world;
}

function leaveWorld() {
    world = null;
    os.platform = realPlatform;
}

function seedFiles(w, seeds) {
    for (const [rel, content] of Object.entries(seeds)) {
        const p = path.join(w.root, rel);
        if (rel.endsWith('/')) {
            fs.mkdirSync(p, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content);
        }
    }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function readTree(root) {
    const files = new Map();
    const dirs = [];
    const walk = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true }).sort(byName);
        if (entries.length === 0 && d !== root) { dirs.push(path.relative(root, d).split(path.sep).join('/')); }
        for (const e of entries) {
            const p = path.join(d, e.name);
            const rel = path.relative(root, p).split(path.sep).join('/');
            if (e.isDirectory()) { walk(p); } else if (e.isFile()) { files.set(rel, fs.readFileSync(p, 'utf8')); } else { files.set(rel, '<not a regular file>'); }
        }
    };
    if (fs.existsSync(root)) { walk(root); }
    return { files, dirs };
}

/**
 * Installed skill files are the unchanged installer's output: a copied
 * fixture SKILL.md is named rather than repeated, and a marker is kept on
 * one line. Every other file is recorded verbatim.
 */
function skillFileShown(rel, text) {
    const parts = rel.split('/');
    if (!parts.includes('skills')) { return text; }
    const name = parts[parts.length - 2];
    if (parts[parts.length - 1] === 'SKILL.md') {
        const hidden = /^user-invocable: false\r?\n/m.test(text);
        if (text.replace(/^user-invocable: false\r?\n/m, '') === fixtureSkillMd(name)) {
            return hidden ? '<fixture SKILL.md + user-invocable: false>' : '<fixture SKILL.md>';
        }
        return text;
    }
    if (parts[parts.length - 1] === '.cmsis-developer-assistant.json') {
        try { return `<marker> ${JSON.stringify(JSON.parse(text))}`; } catch { return text; }
    }
    return text;
}

function dumpWorld(w, seeds) {
    const { files, dirs } = readTree(w.root);
    const out = {};
    for (const [rel, text] of files) { out[rel] = seeds.has(rel) && seeds.get(rel) === text ? '<unchanged seed>' : skillFileShown(rel, text); }
    const removed = [...seeds.keys()].filter((rel) => !files.has(rel));
    return { files: out, ...(dirs.length > 0 ? { emptyDirs: dirs } : {}), ...(removed.length > 0 ? { removedSeeds: removed } : {}) };
}

/** Everything under the code's TMPDIR (the window registry), with per-run values masked. */
function dumpTmp() {
    const { files } = readTree(TMP);
    // The release a window writes into its entry (#14); masked like the MCP definition's, so a version bump changes nothing here.
    const { SERVER_VERSION } = load('debuggingExecutor.js');
    const out = {};
    for (const [rel, text] of files) {
        try {
            const j = JSON.parse(text);
            if (j && typeof j === 'object') {
                if (j.pid === process.pid) { j.pid = '<pid>'; }
                if ('controlPort' in j) { j.controlPort = '<port>'; }
                if ('controlToken' in j) { j.controlToken = '<token>'; }
                if ('updatedAt' in j) { j.updatedAt = '<time>'; }
                if (j.version === SERVER_VERSION) { j.version = '<SERVER_VERSION>'; }
            }
            out[rel] = j;
        } catch {
            out[rel] = text;
        }
    }
    return out;
}

function clearTmp() {
    for (const e of fs.readdirSync(TMP)) { fs.rmSync(path.join(TMP, e), { recursive: true, force: true }); }
}

function makeFolder(w, spec, index) {
    const p = path.join(w.root, spec.name);
    if ((spec.scheme ?? 'file') === 'file') {
        fs.mkdirSync(p, { recursive: true });
        return { uri: fileUri(p), name: spec.name, index };
    }
    return { uri: { ...parseUri(`${spec.scheme}://remote-host/${spec.name}`), fsPath: `/${spec.name}` }, name: spec.name, index };
}

/** A globalState value for the record; a timestamp taken from the clock during the run is masked. */
function stateShown(v) {
    if (typeof v === 'number' && Math.abs(v - Date.now()) < 3_600_000) { return '<Date.now()>'; }
    return u(v);
}

function makeContext(w, def) {
    const extensionPath = def.extensionPath ? def.extensionPath.replace('<w>', w.root) : EXT;
    const memento = (map, name) => ({
        get: (k, d) => (map.has(k) ? clone(map.get(k)) : d),
        update: (k, v) => {
            emit({ ev: name, key: k, value: stateShown(v) });
            if (v === undefined) { map.delete(k); } else { map.set(k, clone(v)); }
            return Promise.resolve();
        },
        keys: () => [...map.keys()],
        setKeysForSync() {},
    });
    return {
        subscriptions: [],
        extensionPath,
        extensionUri: fileUri(extensionPath),
        extension: def.noExtensionInfo ? undefined : { id: 'arm.cmsis-developer-assistant', packageJSON: { version: FIXTURE_VERSION } },
        globalStorageUri: fileUri(path.join(w.root, 'globalStorage')),
        storageUri: fileUri(path.join(w.root, 'workspaceStorage')),
        logUri: fileUri(path.join(w.root, 'logs')),
        globalState: memento(S.globalState, 'globalState'),
        workspaceState: memento(new Map(), 'workspaceState'),
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: event('secrets.onDidChange') },
        asAbsolutePath: (rel) => path.join(extensionPath, rel),
        // Production unless the scenario says otherwise: under the test runner (3) activation leaves the home alone.
        extensionMode: def.extensionMode ?? 1,
    };
}

// ===========================================================================
// Fixture extension: a small skill catalog
// ===========================================================================

/** The whole fixture catalog is installed: the router, the bundled skills and the unrouted devops skill visible, the rest hidden. */
const FIXTURE_SKILLS = [
    { name: 'fx-router', category: 'project', kind: 'router', source: 'generated', displayName: 'FX: Project', shortDescription: 'One command for the fixture project skills.', dependsOn: ['fx-alpha', 'fx-beta', 'fx-missing'], invocable: true },
    { name: 'fx-alpha', category: 'project', kind: 'skill', source: 'cmsis-skills', displayName: 'FX: Alpha', shortDescription: 'Alpha, which needs gamma.', dependsOn: ['fx-gamma'], invocable: false },
    { name: 'fx-beta', category: 'project', kind: 'skill', source: 'cmsis-skills', dependsOn: [], invocable: false },
    { name: 'fx-bundled-a', category: 'project', kind: 'skill', source: 'bundled', dependsOn: [], invocable: true },
    { name: 'fx-gamma', category: 'project', kind: 'skill', source: 'extension', displayName: 'FX: Gamma', shortDescription: 'Gamma, which needs delta.', dependsOn: ['fx-delta'], invocable: false },
    { name: 'fx-delta', category: 'debug', kind: 'skill', source: 'extension', dependsOn: [], invocable: false },
    { name: 'fx-bundled-b', category: 'debug', kind: 'skill', source: 'bundled', dependsOn: [], invocable: true },
    { name: 'fx-broken', category: 'devops', kind: 'skill', source: 'cmsis-skills', displayName: 'FX: Broken', shortDescription: 'Listed, but its directory is missing.', dependsOn: [], missing: true, invocable: true },
    { name: 'fx-help', category: 'help', kind: 'skill', source: 'bundled', dependsOn: [], invocable: true },
];

function fixtureSkillMd(name) {
    return `---\nname: ${name}\ndescription: Fixture skill ${name}.\n---\n\n# ${name}\n`;
}

function writeFixtureExtension() {
    const skills = FIXTURE_SKILLS.map((s) => {
        const rel = s.source === 'cmsis-skills' ? `skills/cmsis-skills/${s.name}` : `skills/${s.name}`;
        if (!s.missing) {
            const dir = path.join(EXT, rel);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'SKILL.md'), fixtureSkillMd(s.name));
        }
        const entry = {
            name: s.name,
            description: `Fixture skill ${s.name}.\n  Its description has a second line.`,
            category: s.category, kind: s.kind, source: s.source, path: rel,
            ...(s.displayName ? { displayName: s.displayName } : {}),
            ...(s.shortDescription ? { shortDescription: s.shortDescription } : {}),
            dependsOn: s.dependsOn,
            invocable: s.invocable,
            // Only cmsis-help is installed; fx-broken stays installed so the missing-directory failure is still exercised.
            installed: ['fx-help', 'fx-broken'].includes(s.name),
        };
        return entry;
    });
    const catalog = { schemaVersion: 1, source: { repository: 'https://example.invalid/cmsis-skills.git', sha: 'f1x7u4e0000000000000000000000000000000000', sourcePath: 'skills' }, skills };
    fs.mkdirSync(path.join(EXT, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(EXT, 'skills', 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    fs.mkdirSync(path.join(EXT, 'docs', 'agent-resources'), { recursive: true });
    fs.writeFileSync(path.join(EXT, 'docs', 'agent-resources', 'tool-contract.md'), FIXTURE_CONTRACT);
}

/** The fixture's tool contract: short rules, so that the rule files in the record stay readable. */
const FIXTURE_RULES = '## CMSIS Developer Assistant tool rules\n\n- Fixture rule one.\n- Fixture rule two.';
const FIXTURE_CONTRACT = [
    '# Fixture tool contract',
    '',
    '<!-- cmsis-developer-assistant:rules:begin -->',
    FIXTURE_RULES,
    '<!-- cmsis-developer-assistant:rules:end -->',
    '',
    '<!-- cmsis-developer-assistant:shell-to-tool:begin -->',
    '| Instead of | Use |',
    '|---|---|',
    '| `pyocd load` | `flash` |',
    '<!-- cmsis-developer-assistant:shell-to-tool:end -->',
    '',
].join('\n');

/** A skill directory this extension installed earlier (it carries the marker). */
function installedSkill(root, name, hidden = false) {
    return {
        [`${root}/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Installed earlier.\n---\n`,
        [`${root}/${name}/.cmsis-developer-assistant.json`]: JSON.stringify({ name, source: 'cmsis-skills', sha: 'old', extensionVersion: 'old', installedAt: '2025-01-01T00:00:00.000Z', hidden }, null, 2) + '\n',
    };
}

/** A same-named skill the user wrote (no marker). */
function foreignSkill(root, name) {
    return { [`${root}/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: The user's own.\n---\n` };
}

// ===========================================================================
// Module loading and instrumentation
// ===========================================================================

function clearOutCache() {
    for (const k of Object.keys(require.cache)) {
        if (k.startsWith(OUT + path.sep)) { delete require.cache[k]; }
    }
}

function load(rel) {
    return require(path.join(OUT, rel));
}

/** Basename of the first stack frame outside this script, i.e. who called the wrapper. */
function callerFile() {
    const lines = (new Error().stack ?? '').split('\n').slice(1);
    for (const line of lines) {
        if (line.includes(__filename)) { continue; }
        const m = /\(?([^()\s]+):\d+:\d+\)?$/.exec(line.trim());
        if (!m || m[1].startsWith('node:')) { continue; }
        return path.basename(m[1]);
    }
    return undefined;
}

function describeValue(v) {
    if (v === undefined) { return '<undefined>'; }
    if (v === null || typeof v !== 'object') { return v; }
    return '<object>';
}

/** Record a call and, for a promise, how it settled. */
function traced(fn, args, invoke) {
    const call = { ev: 'call', fn, ...(args !== undefined ? { args } : {}) };
    emit(call);
    let r;
    try {
        r = invoke();
    } catch (e) {
        emit({ ev: 'threw', fn, error: describeError(e) });
        throw e;
    }
    if (r && typeof r.then === 'function') {
        return r.then(
            (v) => { emit({ ev: 'settled', fn, value: describeValue(v) }); return v; },
            (e) => { emit({ ev: 'rejected', fn, error: describeError(e) }); throw e; },
        );
    }
    if (r !== undefined) { call.returned = describeValue(r); }
    return r;
}

function wrapExport(mod, name, argsOf, after) {
    const orig = mod[name];
    if (typeof orig !== 'function') { throw new Error(`cannot instrument ${name}: not an exported function`); }
    const wrapped = function (...a) {
        const r = traced(name, argsOf ? argsOf(...a) : undefined, () => orig.apply(this, a));
        if (after) { after(r, a); }
        return r;
    };
    mod[name] = wrapped;
    if (mod[name] !== wrapped) { throw new Error(`cannot instrument ${name}: export is read-only`); }
}

function summariseReport(report) {
    return {
        installed: report.installed.map((r) => `${r.root}/${r.name}${r.hidden ? ' (hidden)' : ''}`),
        removed: report.removed.map((r) => `${r.root}/${r.name}`),
        skippedForeign: report.skippedForeign.map((r) => `${r.root}/${r.name}`),
        failed: report.failed.map((r) => `${r.root}${r.name ? `/${r.name}` : ''}: ${r.error}`),
    };
}

function instrumentSkillInstaller(mod) {
    const proto = mod.SkillInstaller.prototype;
    if (proto.__configScenarios) { return; }
    const orig = proto.sync;
    proto.sync = async function (roots, catalog, explicitNames, implied) {
        const all = [...(roots?.install ?? []), ...(roots?.sweepOnly ?? [])];
        const outside = all.filter((r) => !isInside(r, ROOT));
        if (outside.length > 0) {
            violations.push(...outside.map((r) => `skill sync root ${r}`));
            throw new Error(`skill root outside the sandbox refused: ${outside.join(', ')}`);
        }
        const n = ++S.syncCount;
        emit({ ev: 'skillSync', call: n, install: [...roots.install], sweepOnly: [...roots.sweepOnly], explicit: [...explicitNames], implied: [...implied] });
        if (S.ui.beforeSync) { await S.ui.beforeSync(n); }
        const report = await orig.call(this, roots, catalog, explicitNames, implied);
        emit({ ev: 'skillSyncDone', call: n, report: summariseReport(report) });
        return report;
    };
    proto.__configScenarios = true;
}

/** Records the manager's constructor arguments and every call made on it from outside the module. */
function instrumentManager(mod) {
    const Base = mod.AgentConfigurationManager;
    class RecordedAgentConfigurationManager extends Base {
        constructor(context, timeoutInSeconds, serverPort) {
            emit({ ev: 'call', fn: 'new AgentConfigurationManager', args: [context === S.context ? '<context>' : '<other>', timeoutInSeconds, serverPort] });
            super(context, timeoutInSeconds, serverPort);
        }
    }
    for (const name of ['syncSkills', 'migrateExistingConfigurations', 'refreshAgentRules', 'updatePort', 'shouldShowPopup', 'runSetupFlow',
        'resetPopupState']) {
        const orig = Base.prototype[name];
        if (typeof orig !== 'function') { continue; }   // not a prototype method: calls go unrecorded, the diff shows it
        RecordedAgentConfigurationManager.prototype[name] = function (...a) {
            if (callerFile() === 'agentConfigurationManager.js') { return orig.apply(this, a); }
            return traced(`manager.${name}`, a.map(explicit), () => orig.apply(this, a));
        };
    }
    mod.AgentConfigurationManager = RecordedAgentConfigurationManager;
}

function describeCoordinatorOptions(options) {
    const o = {};
    for (const [k, v] of Object.entries(options)) {
        if (k === 'packDocs') {
            o[k] = v === S.packDocs && v !== undefined ? '<handlers returned by createPackDocsHandlers>' : explicit(v);
        } else {
            o[k] = explicit(v);
        }
    }
    return o;
}

function instrumentCoordinator(mod) {
    const Base = mod.WindowCoordinator;
    class RecordedWindowCoordinator extends Base {
        constructor(options) {
            emit({ ev: 'call', fn: 'new WindowCoordinator', args: [describeCoordinatorOptions(options)] });
            super(options);
        }
    }
    // getEndpoint() and isRouter() are queries; how often they are asked is
    // not behaviour, and their answers show in the toast and the provider.
    for (const name of ['start', 'dispose']) {
        const orig = Base.prototype[name];
        if (typeof orig !== 'function') { continue; }
        RecordedWindowCoordinator.prototype[name] = function (...a) {
            if (callerFile() === 'windowCoordinator.js') { return orig.apply(this, a); }
            const args = a.map((x) => (x === S.context ? '<context>' : explicit(x)));
            if (name === 'start' && S.failStart) {
                return traced('coordinator.start', args, () => Promise.reject(new Error('injected coordinator start failure')));
            }
            return traced(`coordinator.${name}`, args, () => orig.apply(this, a));
        };
    }
    mod.WindowCoordinator = RecordedWindowCoordinator;
}

/** A fresh module graph of the extension with its collaborators instrumented. */
function loadExtension() {
    clearOutCache();
    const ext = load('extension.js');
    const m = {
        acm: load('utils/agentConfigurationManager.js'),
        wc: load('windowCoordinator.js'),
        svd: load('core/svdParser.js'),
        sst: load('utils/sessionStateTracker.js'),
        tpr: load('utils/toolchainPackRoot.js'),
        pdh: load('packDocsHost.js'),
        pdc: load('packDocsCommands.js'),
        pdHandler: load('packDocsHandler.js'),
        si: load('utils/skillInstaller.js'),
        de: load('debuggingExecutor.js'),
    };
    instrumentSkillInstaller(m.si);
    instrumentManager(m.acm);
    instrumentCoordinator(m.wc);
    const ctxArg = (c) => (c === S.context ? '<context>' : '<other>');
    wrapExport(m.sst, 'registerSessionStateTracker', (c) => [ctxArg(c)]);
    wrapExport(m.tpr, 'registerToolchainPackRootInvalidation', (c) => [ctxArg(c)]);
    wrapExport(m.svd, 'clearSvdCache', () => []);
    wrapExport(m.pdh, 'readPackDocsGates', () => []);
    wrapExport(m.pdh, 'createPackDocsHandlers', (c, t) => [ctxArg(c), t], (r) => { S.packDocs = r; });
    wrapExport(m.pdc, 'registerPackDocsCommands', (c, h) => [ctxArg(c), h === S.packDocs ? '<handlers returned by createPackDocsHandlers>' : '<other>']);
    const refresh = m.pdHandler.PackDocsHandler.prototype.refreshSettings;
    m.pdHandler.PackDocsHandler.prototype.refreshSettings = function (...a) {
        return traced('packDocs.docs.refreshSettings', undefined, () => refresh.apply(this, a));
    };
    return { ext, m };
}

// ===========================================================================
// Scenario runner
// ===========================================================================

function withTimeout(promise, ms) {
    let timer;
    const t = new Promise((resolve) => { timer = realSetTimeout(() => resolve({ __timedOut: true }), ms); });
    return Promise.race([promise, t]).finally(() => realClearTimeout(timer));
}

async function settle(turns = 5) {
    for (let i = 0; i < turns; i++) { await new Promise((r) => setImmediate(r)); }
}

function normaliser(w) {
    const pairs = [[w.root, '<w>'], [EXT, '<ext>'], [TMP, '<tmpdir>'], [ROOT, '<root>'], [REPO, '<repo>']]
        .sort((a, b) => b[0].length - a[0].length);
    const str = (s) => {
        let t = s;
        for (const [from, to] of pairs) { t = t.split(from).join(to); }
        return t
            .replace(/\.\d+\.[0-9a-f]{8}\.tmp\b/g, '.<pid>.<rand>.tmp')
            .replace(/\.tmp-\d+\b/g, '.tmp-<pid>')
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
            .replace(/\b(localhost|127\.0\.0\.1):(\d+)/g, (m, host, port) => (PORTS.has(Number(port)) ? `${host}:<port>` : m))
            .replace(new RegExp(`\\bwindow-${process.pid}\\b`, 'g'), 'window-<pid>');
    };
    const walk = (v) => {
        if (typeof v === 'string') { return str(v); }
        if (typeof v === 'number') { return PORTS.has(v) ? '<port>' : v; }
        if (Array.isArray(v)) { return v.map(walk); }
        if (v && typeof v === 'object') {
            const o = {};
            for (const [k, x] of Object.entries(v)) { o[str(k)] = walk(x); }
            return o;
        }
        return v;
    };
    return walk;
}

async function runScenario(def) {
    S = newState();
    S.id = def.id;
    const w = enterWorld(def);
    if (def.seed) { seedFiles(w, typeof def.seed === 'function' ? def.seed(w) : def.seed); }
    const seeds = readTree(w.root).files;
    for (const [scope, entries] of Object.entries(def.settings ?? {})) {
        for (const [k, v] of Object.entries(entries)) {
            if (scope === 'global') { S.settings.global.set(k, v); } else if (scope === 'workspace') { S.settings.workspace.set(k, v); } else {
                const p = path.join(w.root, scope);
                const store = S.settings.folders.get(p) ?? new Map();
                store.set(k, v);
                S.settings.folders.set(p, store);
            }
        }
    }
    for (const [k, v] of Object.entries((typeof def.state === 'function' ? def.state(w) : def.state) ?? {})) { S.globalState.set(k, v); }
    S.folders = (def.folders ?? []).map((spec, i) => makeFolder(w, spec, i));
    if (def.workspaceFile) { S.workspaceFile = fileUri(path.join(w.root, def.workspaceFile)); }
    S.ui = def.ui ?? {};
    const ctx = makeContext(w, def);
    S.context = ctx;
    const h = {
        w, ctx, S,
        path: (rel) => path.join(w.root, rel),
        folder: (name) => S.folders.find((f) => f.name === name),
        manager: (timeoutInSeconds = 180, port = 3001) => new ACM.AgentConfigurationManager(ctx, timeoutInSeconds, port),
    };
    S.log = [];
    let result;
    let error;
    let timedOut = false;
    try {
        const r = await withTimeout(Promise.resolve().then(() => def.run(h)), SCENARIO_TIMEOUT_MS);
        if (r && r.__timedOut) { timedOut = true; } else { result = r; }
    } catch (e) {
        error = describeError(e);
    }
    await settle();
    const events = S.log;
    S.log = null;
    const record = {
        id: def.id,
        ...(def.about ? { about: def.about } : {}),
        events,
        ...(result !== undefined ? { result } : {}),
        ...(error ? { error } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        globalState: Object.fromEntries([...S.globalState].map(([k, v]) => [k, stateShown(v)])),
        ...dumpWorld(w, seeds),
    };
    leaveWorld();
    return normaliser(w)(record);
}

/** One call, recorded with its result or error. */
async function attempt(label, fn) {
    try {
        return { call: label, result: explicit(await fn()) };
    } catch (e) {
        return { call: label, error: describeError(e) };
    }
}

// ===========================================================================
// Scenarios: agentConfigurationManager
// ===========================================================================

const KEY = 'cmsis-developer-assistant';
const LEGACY = 'cmsis-debugmcp';
const SETTING = (k) => `cmsis-developer-assistant.${k}`;
const POPUP_KEY = 'cmsis-developer-assistant.popupShown.v5';
/** globalState of releases before 2.5.15; resetPopupState still clears it. */
const LEGACY_PROMPT_KEY = 'cmsis-developer-assistant.skillsPrompt.lastShownAt';
const URL_3001 = 'http://localhost:3001/mcp';

const json = (v, indent = 2) => JSON.stringify(v, null, indent);
const answerWhen = (re, index = 0) => (ev) => (re.test(ev.message) ? index : undefined);

const RULES_KEY = 'cmsis-developer-assistant.agentRules.files';
const OLDER_RULES = '## CMSIS Developer Assistant tool rules\n\n- An older rule.';

/** A rules block as the step writes it: the fixture rules, or older ones for a stale block. */
function rulesBlock(rules = FIXTURE_RULES, eol = '\n') {
    return load('utils/markerBlock.js').renderBlock('rules', load('core/agentRules.js').rulesBlockBody(rules), eol);
}

/** An onRead hook: the agent's file reads differently every time, as if another process kept rewriting it. */
function changingFile(agentId) {
    let n = 0;
    return (p) => (world && p === path.join(world.root, AGENT_FILES[agentId])
        ? json({ n: ++n, mcpServers: { [LEGACY]: { url: 'x' } } })
        : undefined);
}

// Agent files with other servers and unrelated keys.
const SEED_OTHERS = agentSeeds({
    'roo': json({ mcpServers: { 'other-server': { type: 'streamableHttp', url: 'http://localhost:4000/mcp', disabled: true } }, unrelated: { keep: [1, 2, 3] } }, 4) + '\n',
    'antigravity': '{"mcpServers": null, "note": "servers were null"}',
    'cline': '{"foo": 1}',
    'copilot-cli': JSON.stringify({ mcpServers: { a: { type: 'http', url: 'http://a/mcp' }, [KEY]: { type: 'http', url: URL_3001, tools: ['read_memory'], custom: true }, z: {} } }),
    'cursor': '{\n\t"mcpServers": {\n\t\t"other": {}\n\t}\n}\n',
    'codex': '# Codex config\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "npx"\nargs = ["-y", "other-mcp"]\n\n[profiles.fast]\nmodel = "o4-mini"\n',
    'kimi-code': json({ mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' }, fs: { command: 'npx', args: ['-y', 'fs-mcp'], toolTimeoutMs: 5000 } } }),
    'claude-code': JSON.stringify({ numStartups: 3, projects: { '/p': { allowedTools: [], history: ['x'] } }, mcpServers: { other: { type: 'stdio', command: 'x' }, [KEY]: { x: 1 } }, userID: 'abc' }),
    'claude-desktop': json({ mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'] } }, globalShortcut: 'Ctrl+Space' }),
});

// Entries only under the pre-rename key.
const SEED_LEGACY = agentSeeds({
    'roo': json({ mcpServers: { [LEGACY]: { autoApprove: ['read_memory'], disabled: false, timeout: 60, type: 'sse', url: 'http://localhost:3001/sse' } } }),
    'antigravity': json({ mcpServers: { [LEGACY]: { type: 'streamableHttp', url: URL_3001 } } }),
    'cline': json({ mcpServers: { [LEGACY]: { autoApprove: ['a'], disabled: false, timeout: 180, type: 'streamableHttp', url: URL_3001 } } }),
    'copilot-cli': json({ mcpServers: { [LEGACY]: { type: 'http', url: URL_3001, tools: ['*'] } } }),
    'cursor': json({ mcpServers: { [LEGACY]: { type: 'sse', url: 'http://localhost:3001/sse' } } }),
    'codex': '[mcp_servers.cmsis-debugmcp]\nurl = "http://localhost:3001/sse"\nstartup_timeout_sec = 30\n\n[mcp_servers.cmsis-debugmcp.env]\nX = "1"\n',
    'kimi-code': json({ mcpServers: { [LEGACY]: { transport: 'http', url: URL_3001 } } }),
    'claude-code': json({ numStartups: 1, mcpServers: { [LEGACY]: { type: 'http', url: URL_3001 } } }),
    'claude-desktop': json({ mcpServers: { [LEGACY]: { command: 'npx', args: ['-y', 'mcp-remote', URL_3001] } } }),
});

// Entries under our key with a stale port, URL or transport.
const SEED_STALE = agentSeeds({
    'roo': json({ mcpServers: { [KEY]: { autoApprove: ['a'], disabled: true, timeout: 10, type: 'streamableHttp', url: 'http://localhost:9999/mcp', extra: 1 } } }),
    'antigravity': json({ mcpServers: { [KEY]: { type: 'sse', url: 'http://localhost:3001/sse' } } }),
    'cline': json({ mcpServers: { [KEY]: { autoApprove: [], disabled: false, timeout: 180, type: 'streamableHttp', url: 'http://127.0.0.1:3001/mcp' } } }),
    'copilot-cli': json({ mcpServers: { [KEY]: { type: 'streamableHttp', url: 'http://localhost:9999/mcp' } } }),
    'cursor': json({ mcpServers: { [KEY]: { url: 'http://localhost:9999/sse' } } }),
    'codex': '[mcp_servers.cmsis-developer-assistant]\n  url = "http://localhost:9999/mcp" # old port\nstartup_timeout_sec = 10\n',
    'kimi-code': json({ mcpServers: { [KEY]: { url: 'http://localhost:9999/mcp', enabledTools: ['read_memory'] } } }),
    'claude-code': json({ mcpServers: { [KEY]: { type: 'http', url: 'http://localhost:9999/mcp', headers: { a: 'b' } } } }),
    'claude-desktop': json({ mcpServers: { [KEY]: { command: 'npx', args: ['-y', 'mcp-remote', 'http://localhost:9999/mcp'], env: { X: '1' } } } }),
});

function configureAll(extra = {}) {
    return {
        ui: { agents: 'all', ...extra.ui },
        ...(extra.settings ? { settings: extra.settings } : {}),
        run: async (h) => {
            const m = h.manager();
            await m.runSetupFlow();
            return { shouldShowPopupAfter: await m.shouldShowPopup() };
        },
    };
}

function configureOne(agentDisplayName) {
    return {
        ui: { agents: [agentDisplayName] },
        run: async (h) => { await h.manager().runSetupFlow(); },
    };
}

function migrate(timeoutInSeconds = 180, port = 3001) {
    return async (h) => { await h.manager(timeoutInSeconds, port).migrateExistingConfigurations(); };
}

function pureHelperCases() {
    const U = URL_3001;
    const upserts = [
        ['empty', ''],
        ['no newline', 'model = "x"'],
        ['trailing newline', 'model = "x"\n'],
        ['two trailing newlines', 'model = "x"\n\n'],
        ['ours, CRLF', '[mcp_servers.cmsis-developer-assistant]\r\nurl = "old"\r\n\r\n[other]\r\nk = 1\r\n'],
        ['ours, indented url with comment', '[mcp_servers.cmsis-developer-assistant]\n  url = "old" # c\ntimeout = 5\n'],
        ['ours without url, next table has url', '[mcp_servers.cmsis-developer-assistant]\ntimeout = 5\n[other]\nurl = "keep"'],
        ['ours followed by our sub-table', '[mcp_servers.cmsis-developer-assistant]\n[mcp_servers.cmsis-developer-assistant.env]\nurl = "env"\n'],
        ['indented header with comment', '  [mcp_servers.cmsis-developer-assistant]  # ours\nurls = "x"\n# url = "y"\n'],
        ['quoted key header', '[mcp_servers."cmsis-developer-assistant"]\nurl = "old"\n'],
        ['spaced header', '[ mcp_servers.cmsis-developer-assistant ]\nurl = "old"\n'],
        ['array-of-tables boundary', '[[profiles]]\nname = "a"\n[mcp_servers.cmsis-developer-assistant]\ntimeout = 5\n[[profiles]]\nname = "b"\n'],
        ['url line without spaces', '[mcp_servers.cmsis-developer-assistant]\nurl="old"\n'],
        ['legacy section only', '[mcp_servers.cmsis-debugmcp]\nurl = "old"\n'],
        ['header twice', '[mcp_servers.cmsis-developer-assistant]\nurl = "a"\n[mcp_servers.cmsis-developer-assistant]\nurl = "b"\n'],
    ].map(([label, input]) => ({ fn: 'upsertCodexDebugMCPConfig', label, input, url: U, output: ACM.upsertCodexDebugMCPConfig(input, U) }));
    upserts.push({ fn: 'upsertCodexDebugMCPConfig', label: 'escaping', input: '', url: 'http://h/a"b\\c', output: ACM.upsertCodexDebugMCPConfig('', 'http://h/a"b\\c') });
    const strips = [
        ['absent, CRLF kept', 'a = 1\r\n[other]\r\nk = 1\r\n'],
        ['between tables', 'a = 1\n\n[mcp_servers.cmsis-debugmcp]\nurl = "x"\n\n[other]\nk = 1\n'],
        ['only the legacy section', '[mcp_servers.cmsis-debugmcp]\nurl = "x"\n'],
        ['legacy sub-table survives', '[mcp_servers.cmsis-debugmcp]\nurl = "x"\n[mcp_servers.cmsis-debugmcp.env]\nA = "1"\n'],
        ['first occurrence only', '[mcp_servers.cmsis-debugmcp]\nurl = "1"\n[x]\n[mcp_servers.cmsis-debugmcp]\nurl = "2"\n'],
        ['CRLF with legacy', 'a = 1\r\n[mcp_servers.cmsis-debugmcp]\r\nurl = "x"\r\n'],
        ['indented legacy header with comment', '  [mcp_servers.cmsis-debugmcp] # old\nurl = "x"\n'],
    ].map(([label, input]) => ({ fn: 'stripLegacyCodexSection', label, input, output: ACM.stripLegacyCodexSection(input) }));
    const jsonAgent = { id: 'x', name: 'x', displayName: 'X', configPath: '/nonexistent/x.json', configFormat: 'json', mcpServerFieldName: 'mcpServers' };
    const otherField = { ...jsonAgent, mcpServerFieldName: 'servers' };
    const tomlAgent = { id: 'codex', name: 'codex', displayName: 'Codex', configPath: '/nonexistent/config.toml', configFormat: 'toml' };
    const has = [
        [jsonAgent, JSON.stringify({ mcpServers: { [KEY]: { url: 'x' } } })],
        [jsonAgent, JSON.stringify({ mcpServers: { [KEY]: null } })],
        [jsonAgent, JSON.stringify({ mcpServers: { [LEGACY]: {} } })],
        [jsonAgent, JSON.stringify({ mcpServers: null })],
        [jsonAgent, JSON.stringify({ mcpServers: [] })],
        [jsonAgent, JSON.stringify({ mcpServers: 'cmsis-developer-assistant' })],
        [jsonAgent, JSON.stringify([{ mcpServers: { [KEY]: {} } }])],
        [jsonAgent, 'null'],
        [jsonAgent, ''],
        [jsonAgent, '{"mcpServers": {"cmsis-developer-assistant": {}}, // c\n}'],
        [jsonAgent, JSON.stringify({ mcpServers: { [KEY]: false } })],
        [otherField, JSON.stringify({ mcpServers: { [KEY]: {} } })],
        [otherField, JSON.stringify({ servers: { [KEY]: {} } })],
        [tomlAgent, '[mcp_servers.cmsis-developer-assistant]\nurl = "x"\n'],
        [tomlAgent, 'a = 1\r\n  [mcp_servers.cmsis-developer-assistant] # c\r\n'],
        [tomlAgent, '[mcp_servers.cmsis-debugmcp]\nurl = "x"\n'],
        [tomlAgent, '[mcp_servers."cmsis-developer-assistant"]\n'],
        [tomlAgent, ''],
    ].map(([agent, content]) => ({ fn: 'agentConfigHasServer', agent: `${agent.configFormat}/${agent.mcpServerFieldName ?? '-'}`, content, output: ACM.agentConfigHasServer(agent, content) }));
    return {
        constants: { SERVER_KEY: ACM.SERVER_KEY, LEGACY_SERVER_KEY: ACM.LEGACY_SERVER_KEY },
        cases: [...upserts, ...strips, ...has],
    };
}

let ACM = null;

function agentScenarios() {
    const popupDone = { [POPUP_KEY]: true };
    const registeredSeeds = agentSeeds({
        'codex': '[mcp_servers.cmsis-developer-assistant]\nurl = "http://localhost:3001/mcp"\n',
        'claude-code': json({ mcpServers: { [KEY]: { type: 'http', url: URL_3001 } } }),
    });
    return [
        // --- pure helpers -------------------------------------------------------------
        { id: 'agents/pure-helpers', about: 'exported TOML helpers and agentConfigHasServer', run: async () => pureHelperCases() },

        // --- roster: where each agent's file lives -----------------------------------------
        { id: 'agents/roster-darwin', about: 'configure all nine on darwin, no files yet; the skills go to the personal directories', ...configureAll() },
        { id: 'agents/roster-win32-appdata', platform: 'win32', env: { APPDATA: '<w>/appdata' }, ...configureAll() },
        { id: 'agents/roster-win32-no-appdata', platform: 'win32', ...configureAll() },
        { id: 'agents/roster-linux-xdg', platform: 'linux', env: { XDG_CONFIG_HOME: '<w>/xdg' }, ...configureAll() },
        { id: 'agents/roster-linux-default', platform: 'linux', ...configureAll() },
        { id: 'agents/roster-unknown-platform', platform: 'aix', env: { APPDATA: '<w>/appdata' }, ...configureAll() },
        {
            id: 'agents/roster-env-overrides', about: 'CODEX_HOME / COPILOT_HOME / KIMI_CODE_HOME honoured, CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME not (darwin)',
            env: { CODEX_HOME: '<w>/codex-home', COPILOT_HOME: '<w>/copilot-home', KIMI_CODE_HOME: '<w>/kimi-home', CLAUDE_CONFIG_DIR: '<w>/claude-config', XDG_CONFIG_HOME: '<w>/xdg' },
            ...configureAll(),
        },
        {
            id: 'agents/roster-empty-env', about: 'empty variables count as unset (win32)', platform: 'win32',
            env: { APPDATA: '', CODEX_HOME: '', COPILOT_HOME: '', KIMI_CODE_HOME: '' }, ...configureAll(),
        },

        // --- configure over existing files ---------------------------------------------------
        { id: 'agents/configure-existing-other-servers', seed: SEED_OTHERS, ...configureAll() },
        { id: 'agents/configure-legacy-key', about: 'configure adds the new key; the legacy entries, all on our endpoint, go as duplicates', seed: SEED_LEGACY, ...configureAll() },
        {
            id: 'agents/configure-kimi-duplicate', about: 'Configure Agent → Kimi Code over a hand-written entry for the same server: ours replaces it, and the toast says so',
            seed: agentSeeds({ 'kimi-code': json({ mcpServers: { 'CMSIS Developer Assistant': { url: 'http://localhost:3001/mcp' }, linear: { url: 'https://mcp.linear.app/mcp' } } }) }),
            ...configureOne('Kimi Code'),
        },
        { id: 'agents/configure-stale-entries', seed: SEED_STALE, ...configureAll() },
        {
            id: 'agents/configure-invalid-files', about: 'JSONC, empty, non-object and odd mcpServers values',
            seed: agentSeeds({
                'cline': '{\n  // comment\n  "mcpServers": {}\n}\n',
                'roo': '',
                'cursor': '[]',
                'antigravity': '{"mcpServers": []}',
                'copilot-cli': '{"mcpServers": "str"}',
                'claude-desktop': '"just a string"',
            }),
            ...configureAll(),
        },
        {
            id: 'agents/configure-write-failures', about: 'a file where a config directory should be; the other agents still run',
            seed: { 'home/.gemini': 'not a directory', 'home/.codex': 'not a directory either' },
            ...configureAll(),
        },
        {
            id: 'agents/configure-file-keeps-changing', about: '~/.claude.json differs on every read: the read-modify-write gives up; the next agent still runs',
            seed: agentSeeds({ 'claude-code': json({ n: 0, mcpServers: {} }) }),
            ui: { agents: ['Claude Code', 'Claude Desktop'], onRead: changingFile('claude-code') },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/configure-open-config', about: 'the success toast button opens the file; answers are awaited in order',
            ui: { agents: ['Cline', 'Codex', 'Claude Desktop'], message: answerWhen(/Cline|Claude Desktop/) },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/configure-port-and-timeout', about: 'constructor timeout 42 and updatePort(4555) reach the written entries',
            ui: { agents: 'all' },
            run: async (h) => { const m = h.manager(42, 3001); m.updatePort(4555); await m.runSetupFlow(); },
        },
        { id: 'agents/configure-codex-crlf', seed: agentSeeds({ codex: '[mcp_servers.cmsis-developer-assistant]\r\nurl = "http://localhost:9999/mcp"\r\n\r\n[other]\r\nk = 1\r\n' }), ...configureOne('Codex') },
        { id: 'agents/configure-codex-quoted-key', seed: agentSeeds({ codex: '[mcp_servers."cmsis-developer-assistant"]\nurl = "http://localhost:9999/mcp"\n' }), ...configureOne('Codex') },
        { id: 'agents/configure-codex-indented-header', seed: agentSeeds({ codex: 'model = "x"\n  [mcp_servers.cmsis-developer-assistant]  # ours\nurls = "x"\n# url = "y"\n\n[mcp_servers.cmsis-developer-assistant.env]\nurl = "keep"\n' }), ...configureOne('Codex') },
        { id: 'agents/configure-codex-no-trailing-newline', seed: agentSeeds({ codex: 'model = "x"' }), ...configureOne('Codex') },

        // --- migration on activation ------------------------------------------------------------
        { id: 'agents/migrate-legacy-keys', seed: SEED_LEGACY, run: migrate() },
        { id: 'agents/migrate-stale-entries', seed: SEED_STALE, run: migrate() },
        {
            id: 'agents/migrate-mixed-home', about: 'rename, both keys, sse, wrong transport, silent port refresh, JSONC skipped, Codex legacy',
            seed: agentSeeds({
                'cline': json({ mcpServers: { [LEGACY]: { type: 'streamableHttp', url: URL_3001, autoApprove: ['a'] } } }),
                'roo': json({ mcpServers: { [LEGACY]: { url: 'old' }, [KEY]: { autoApprove: [], disabled: false, timeout: 180, type: 'streamableHttp', url: URL_3001 } } }),
                'cursor': json({ mcpServers: { [KEY]: { type: 'sse', url: 'http://localhost:3001/sse', autoApprove: ['x'], custom: 1 } } }),
                'copilot-cli': json({ mcpServers: { [KEY]: { type: 'streamableHttp', url: URL_3001 } } }),
                'claude-code': json({ numStartups: 2, mcpServers: { [KEY]: { type: 'http', url: 'http://localhost:9999/mcp' } } }),
                'claude-desktop': json({ mcpServers: { [KEY]: { command: 'npx', args: ['-y', 'mcp-remote', 'http://localhost:9999/mcp'] } } }),
                'antigravity': '{\n  // JSONC\n  "mcpServers": {"cmsis-debugmcp": {"url": "http://localhost:3001/sse"}}\n}\n',
                'codex': 'model = "o3"\n\n[mcp_servers.cmsis-debugmcp]\nurl = "http://localhost:3001/sse"\nstartup_timeout_sec = 30\n\n[mcp_servers.cmsis-debugmcp.env]\nX = "1"\n\n[mcp_servers.other]\nurl = "http://other/mcp"\n',
            }),
            run: migrate(),
        },
        { id: 'agents/migrate-codex-our-stale-port', about: 'a non-/sse stale port is left alone', seed: agentSeeds({ codex: '[mcp_servers.cmsis-developer-assistant]\nurl = "http://localhost:9999/mcp"\n' }), run: migrate() },
        { id: 'agents/migrate-codex-our-sse-crlf', seed: agentSeeds({ codex: 'a = 1\r\n[mcp_servers.cmsis-developer-assistant]\r\n  url = \'http://localhost:3001/sse\' # c\r\n' }), run: migrate() },
        { id: 'agents/migrate-codex-sse-in-comment', seed: agentSeeds({ codex: '[mcp_servers.cmsis-developer-assistant]\nurl = "http://localhost:3001/mcp" # was /sse\n' }), run: migrate() },
        { id: 'agents/migrate-codex-legacy-only-crlf', seed: agentSeeds({ codex: '[mcp_servers.cmsis-debugmcp]\r\nurl = "http://localhost:3001/mcp"\r\n' }), run: migrate() },
        { id: 'agents/migrate-silent-refresh-only', about: 'a pure endpoint refresh is written without a toast', seed: agentSeeds({ 'claude-code': json({ mcpServers: { [KEY]: { type: 'http', url: 'http://localhost:9999/mcp' } } }) }), run: migrate() },
        {
            id: 'agents/migrate-unparseable-and-absent',
            seed: agentSeeds({
                'cline': '{\n  // JSONC\n  "mcpServers": {"cmsis-debugmcp": {"type": "sse"}}\n}\n',
                'roo': '',
                'cursor': '[]',
                'copilot-cli': '{"mcpServers":{"other":{}}}',
                'claude-desktop': '{not json',
                'antigravity': '{"mcpServers": []}',
            }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-falsy-values',
            seed: agentSeeds({
                'cline': json({ mcpServers: { [LEGACY]: null } }),
                'roo': json({ mcpServers: { [LEGACY]: { url: 'x' }, [KEY]: null } }),
                'cursor': json({ mcpServers: { [KEY]: null } }),
                'copilot-cli': json({ mcpServers: { [KEY]: { type: 'sse', autoApprove: 'not-an-array' } } }),
            }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-autoapprove-kept',
            seed: agentSeeds({
                'claude-code': json({ mcpServers: { [KEY]: { type: 'sse', url: 'http://localhost:3001/sse', autoApprove: ['x'], custom: 1 } } }),
                'claude-desktop': json({ mcpServers: { [KEY]: { command: 'npx', args: ['-y', 'mcp-remote', 'http://localhost:3001/sse'], autoApprove: ['y'] } } }),
                'roo': json({ mcpServers: { [KEY]: { url: 'http://localhost:3001/sse', autoApprove: ['z'], timeout: 5 } } }),
            }),
            run: migrate(),
        },
        { id: 'agents/migrate-other-port', about: 'constructed with port 4555 and timeout 42', seed: SEED_STALE, run: migrate(42, 4555) },
        {
            id: 'agents/migrate-kimi-adds-tool-timeout', about: 'a hand-written Kimi Code entry without toolTimeoutMs gets it and keeps its other fields; reported',
            seed: agentSeeds({ 'kimi-code': json({ mcpServers: { [KEY]: { transport: 'http', url: URL_3001, headers: { a: 'b' } }, other: { url: 'http://other/mcp' } } }) }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-kimi-own-tool-timeout', about: 'a toolTimeoutMs the user set stays; nothing is written',
            seed: agentSeeds({ 'kimi-code': json({ mcpServers: { [KEY]: { url: URL_3001, toolTimeoutMs: 120000 } } }) }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-kimi-sse', about: 'a Kimi Code entry on transport "sse" is replaced by the current shape',
            seed: agentSeeds({ 'kimi-code': json({ mcpServers: { [KEY]: { transport: 'sse', url: 'http://localhost:3001/sse' } } }) }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-kimi-duplicate-entry',
            about: 'the tester\'s file: a hand-written "CMSIS Developer Assistant" next to ours goes, a loopback entry on another port and a remote one stay; the toast names the key',
            seed: agentSeeds({ 'kimi-code': json({ mcpServers: {
                'CMSIS Developer Assistant': { url: 'http://localhost:3001/mcp', transport: 'http' },
                [KEY]: { url: URL_3001, toolTimeoutMs: 630000 },
                'other-local': { url: 'http://127.0.0.1:4000/mcp' },
                linear: { url: 'https://mcp.linear.app/mcp' },
            } }) }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-duplicates-merge-autoapprove',
            about: 'Roo Code: entries at 127.0.0.1:3001/mcp/ and localhost:3001/sse next to ours go, their autoApprove lists join ours; Claude Desktop: an mcp-remote bridge to our port goes',
            seed: agentSeeds({
                'roo': json({ mcpServers: {
                    [KEY]: { autoApprove: ['a'], disabled: false, timeout: 180, type: 'streamableHttp', url: URL_3001 },
                    mine: { url: 'http://127.0.0.1:3001/mcp/', autoApprove: ['b', 'a'] },
                    old: { url: 'http://localhost:3001/sse' },
                } }),
                'claude-desktop': json({ mcpServers: {
                    [KEY]: { command: 'npx', args: ['-y', 'mcp-remote', URL_3001] },
                    bridge: { command: 'npx', args: ['mcp-remote', 'http://localhost:3001/mcp'] },
                } }),
            }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-duplicate-without-ours', about: 'a hand-written entry alone is no duplicate: nothing is written',
            seed: agentSeeds({ 'kimi-code': json({ mcpServers: { 'CMSIS Developer Assistant': { url: URL_3001 } } }) }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-kimi-odd-entry', about: 'a non-object entry under our key is left alone',
            seed: agentSeeds({ 'kimi-code': json({ mcpServers: { [KEY]: 'not an entry' } }) }),
            run: migrate(),
        },
        {
            id: 'agents/migrate-cursor-old-location', about: 'the entry an earlier release wrote where Cursor does not read moves to ~/.cursor/mcp.json; the old file goes',
            seed: { [OLD_CURSOR_FILE]: json({ mcpServers: { [KEY]: { autoApprove: [], disabled: false, timeout: 180, type: 'streamableHttp', url: URL_3001 } } }) },
            run: migrate(),
        },
        {
            id: 'agents/migrate-cursor-old-location-merge', about: 'legacy key in the old file, other servers in both: merged; the old file keeps what is not ours',
            seed: {
                [OLD_CURSOR_FILE]: json({ mcpServers: { [LEGACY]: { type: 'sse', url: 'http://localhost:3001/sse' }, other: { url: 'http://other/mcp' } }, note: 1 }),
                ...agentSeeds({ cursor: json({ mcpServers: { mine: { command: 'x' } } }) }),
            },
            run: migrate(),
        },
        {
            id: 'agents/migrate-cursor-already-registered', about: 'an entry the user put in ~/.cursor/mcp.json wins; the old one is dropped',
            seed: {
                [OLD_CURSOR_FILE]: json({ mcpServers: { [KEY]: { type: 'streamableHttp', url: URL_3001 } } }),
                ...agentSeeds({ cursor: json({ mcpServers: { [KEY]: { url: URL_3001, headers: { a: 'b' } } } }) }),
            },
            run: migrate(),
        },
        {
            id: 'agents/migrate-cursor-target-unparseable', about: 'a JSONC ~/.cursor/mcp.json is not rewritten, and the old entry stays for a later run',
            seed: {
                [OLD_CURSOR_FILE]: json({ mcpServers: { [KEY]: { type: 'streamableHttp', url: URL_3001 } } }),
                ...agentSeeds({ cursor: '{\n  // mine\n  "mcpServers": {}\n}\n' }),
            },
            run: migrate(),
        },
        {
            id: 'agents/migrate-cursor-old-file-without-entry', about: 'an old file without our entry is left alone and nothing is created',
            seed: { [OLD_CURSOR_FILE]: json({ mcpServers: { other: {} } }) },
            run: migrate(),
        },
        {
            id: 'agents/migrate-file-keeps-changing', about: 'Claude Code file differs on every read: skipped (logged); Cline still migrated',
            seed: agentSeeds({
                'claude-code': json({ n: 0, mcpServers: { [LEGACY]: { url: 'x' } } }),
                'cline': json({ mcpServers: { [LEGACY]: { type: 'streamableHttp', url: URL_3001 } } }),
            }),
            ui: { onRead: changingFile('claude-code') },
            run: migrate(),
        },
        { id: 'agents/migrate-empty-home', run: migrate() },

        // --- popup state ---------------------------------------------------------------------------
        { id: 'agents/popup-fresh', run: async (h) => h.manager().shouldShowPopup() },
        { id: 'agents/popup-antigravity-env', env: { ANTIGRAVITY_ENV: 'true' }, run: async (h) => h.manager().shouldShowPopup() },
        { id: 'agents/popup-antigravity-env-not-true', env: { ANTIGRAVITY_ENV: '1' }, run: async (h) => h.manager().shouldShowPopup() },
        { id: 'agents/popup-gemini-home', env: { GEMINI_HOME: '<w>/gemini' }, run: async (h) => h.manager().shouldShowPopup() },
        { id: 'agents/popup-gemini-home-empty', env: { GEMINI_HOME: '' }, run: async (h) => h.manager().shouldShowPopup() },
        { id: 'agents/popup-already-shown', state: popupDone, run: async (h) => h.manager().shouldShowPopup() },
        {
            id: 'agents/popup-reset', state: { [POPUP_KEY]: true, [LEGACY_PROMPT_KEY]: FIXED_NOW },
            run: async (h) => { const m = h.manager(); const before = await m.shouldShowPopup(); await m.resetPopupState(); return { before, after: await m.shouldShowPopup() }; },
        },

        // --- the setup flow --------------------------------------------------------------------------
        {
            id: 'agents/setup-agents-install-skills', about: 'two agents (Cline answered "open"); accepting installs the whole catalog into the personal directories',
            seed: { 'home/.claude/': '' },
            ui: { agents: ['Cline', 'Codex'], message: answerWhen(/Cline/) },
            run: async (h) => { const m = h.manager(); await m.runSetupFlow(); return { shouldShowPopupAfter: await m.shouldShowPopup() }; },
        },
        {
            id: 'agents/setup-dismiss-both', about: 'the agent picker dismissed: no skills installed, the rules step still comes', ui: { agents: null },
            run: async (h) => { const m = h.manager(); await m.runSetupFlow(); return { shouldShowPopupAfter: await m.shouldShowPopup() }; },
        },
        {
            id: 'agents/setup-accept-nothing', about: 'empty agent selection accepted: nothing registered, no skills installed',
            ui: { agents: [] },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/setup-picker-throws', ui: { quickPickThrows: true },
            run: async (h) => { const m = h.manager(); await m.runSetupFlow(); return { shouldShowPopupAfter: await m.shouldShowPopup() }; },
        },
        {
            id: 'agents/setup-with-folders', about: 'two file folders and a remote one: the skills still go to the personal directories; 2.5.x project copies are swept',
            folders: [{ name: 'wsA' }, { name: 'wsB' }, { name: 'remote', scheme: 'vscode-vfs' }],
            seed: { ...installedSkill('wsB/.agents/skills', 'fx-beta', true), ...foreignSkill('wsA/.agents/skills', 'fx-alpha') },
            ui: { agents: ['Cursor'] },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/setup-home-as-folder', about: 'the home directory is open as a workspace folder: its project roots are the personal roots, written and not swept, so every skill stays installed',
            folders: [{ name: 'home' }],
            seed: { 'home/.claude/settings.json': '{}\n' },
            ui: { agents: ['Claude Code'] },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/setup-no-catalog', about: 'the catalog cannot be loaded: the agents are registered, the user is told that no skills were installed',
            extensionPath: '<w>/extension-without-catalog', ui: { agents: ['Cursor'] },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },

        // --- the tool rules step ------------------------------------------------------------------------
        {
            id: 'agents/rules-user-files-written', about: 'Claude Code and Codex set up: their user files are preselected, each shown as a diff and written on Write',
            seed: { 'home/.codex/AGENTS.md': '# My Codex notes\n\nUse tabs.\n' },
            ui: { agents: ['Claude Code', 'Codex'], rules: 'keep', message: answerWhen(/tool rules/) },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/rules-kimi-code', about: 'Kimi Code: its user AGENTS.md under KIMI_CODE_HOME is preselected, the workspace AGENTS.md is offered unchecked',
            folders: [{ name: 'wsA' }],
            env: { KIMI_CODE_HOME: '<w>/kimi-home' },
            ui: { agents: ['Kimi Code'], rules: 'keep', message: answerWhen(/tool rules/) },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/rules-preview-declined', about: 'the diff is shown and the dialog dismissed: no rule file is written',
            ui: { agents: ['Claude Code'], rules: 'keep' },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/rules-shared-agents-md', about: 'the workspace AGENTS.md of Codex, Copilot CLI, Antigravity and Copilot Chat is one item, written once; the user files unchecked',
            folders: [{ name: 'wsA' }],
            seed: { 'wsA/AGENTS.md': '# Team rules\n' },
            ui: { agents: ['Codex', 'GitHub Copilot CLI', 'Antigravity'], rules: ['wsA/AGENTS.md'], message: answerWhen(/tool rules/) },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/rules-workspace-own-files', about: 'Cursor, Cline and Roo Code get files of their own, Claude Code the project CLAUDE.md it reads',
            folders: [{ name: 'wsA' }],
            seed: { 'wsA/CLAUDE.md': '# Project notes\n', 'wsA/.roo/rules/style.md': 'Be brief.\n' },
            ui: {
                agents: ['Cursor', 'Cline', 'Roo Code', 'Claude Code'],
                rules: ['wsA/CLAUDE.md', 'wsA/.cursor', 'wsA/.clinerules', 'wsA/.roo'], message: answerWhen(/tool rules/),
            },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/rules-remove', about: 'files that have the rules open checked; unchecking takes them out on Remove, deleting what was made for them',
            folders: [{ name: 'wsA' }],
            seed: () => ({
                'home/.claude/CLAUDE.md': `${rulesBlock()}\n`,
                'home/.codex/AGENTS.md': `# Mine\n\n${rulesBlock()}\n`,
                'wsA/.cursor/rules/cmsis-developer-assistant.mdc': `---\ndescription: CMSIS Developer Assistant tool rules\nalwaysApply: true\n---\n\n${rulesBlock()}\n`,
            }),
            state: (w) => ({
                [RULES_KEY]: [
                    { file: path.join(w.root, 'home/.claude/CLAUDE.md'), scope: 'user', form: 'block', agents: ['claude-code'], created: true, createdDirs: [path.join(w.root, 'home/.claude')] },
                    { file: path.join(w.root, 'home/.codex/AGENTS.md'), scope: 'user', form: 'block', agents: ['codex'], created: false, createdDirs: [] },
                    {
                        file: path.join(w.root, 'wsA/.cursor/rules/cmsis-developer-assistant.mdc'), scope: 'workspace', form: 'own', agents: ['cursor'],
                        created: true, createdDirs: [path.join(w.root, 'wsA/.cursor'), path.join(w.root, 'wsA/.cursor/rules')],
                    },
                ],
            }),
            ui: { agents: null, rules: [], message: answerWhen(/tool rules/) },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/rules-never', about: 'agentRules.install "never": the setup has no rules step',
            settings: { global: { [SETTING('agentRules.install')]: 'never' } },
            ui: { agents: ['Claude Code'] },
            run: async (h) => { await h.manager().runSetupFlow(); },
        },
        {
            id: 'agents/rules-no-contract', about: 'the tool contract cannot be read: the step is skipped, the setup still counts as answered',
            extensionPath: '<w>/extension-without-contract', ui: { agents: ['Claude Code'] },
            run: async (h) => { const m = h.manager(); await m.runSetupFlow(); return { shouldShowPopupAfter: await m.shouldShowPopup() }; },
        },
        ...(() => {
            const seed = () => ({
                'home/.codex/AGENTS.md': `# Before\r\n\r\n${rulesBlock(OLDER_RULES, '\r\n')}\r\n\r\n# After\r\n`,
                'home/.claude/CLAUDE.md': `${rulesBlock()}\n`,
                'wsA/AGENTS.md': '# The user took the block out\n',
                'home/.gemini/AGENTS.md': `${rulesBlock(OLDER_RULES)}\n`,
            });
            const records = (w) => ({
                [RULES_KEY]: ['home/.codex/AGENTS.md', 'home/.claude/CLAUDE.md', 'wsA/AGENTS.md', 'home/.copilot/copilot-instructions.md'].map((rel) => ({
                    file: path.join(w.root, rel), scope: rel.startsWith('home/') ? 'user' : 'workspace', form: 'block', agents: ['codex'], created: false, createdDirs: [],
                })),
            });
            const refresh = { folders: [{ name: 'wsA' }], seed, run: async (h) => { await h.manager().refreshAgentRules(); } };
            return [
                {
                    ...refresh, id: 'agents/rules-refresh',
                    about: 'activation: Review, then Write updates a recorded stale block in place (CRLF kept); a missing file and a deleted block are forgotten, not recreated; an unrecorded file is left',
                    state: (w) => ({ ...popupDone, ...records(w) }), ui: { message: 0 },
                },
                {
                    ...refresh, id: 'agents/rules-refresh-not-now',
                    about: 'activation: Not Now writes nothing; the offer is not repeated for the same rules',
                    state: (w) => ({ ...popupDone, ...records(w) }), ui: { message: 1 },
                    run: async (h) => { const m = h.manager(); await m.refreshAgentRules(); await m.refreshAgentRules(); },
                },
                {
                    ...refresh, id: 'agents/rules-refresh-declined',
                    about: 'activation: Review, then the preview declined: the stale block stays',
                    state: (w) => ({ ...popupDone, ...records(w) }), ui: { message: seq(0, undefined) },
                },
                {
                    ...refresh, id: 'agents/rules-refresh-setup-due',
                    about: 'activation while the setup is due: no offer, the setup step offers the update',
                    state: records, ui: { message: 0 },
                },
            ];
        })(),
        {
            id: 'agents/rules-refresh-never', about: 'agentRules.install "never": activation leaves a recorded stale block alone',
            seed: () => ({ 'home/.codex/AGENTS.md': `${rulesBlock(OLDER_RULES)}\n` }),
            state: (w) => ({ [RULES_KEY]: [{ file: path.join(w.root, 'home/.codex/AGENTS.md'), scope: 'user', form: 'block', agents: ['codex'], created: false, createdDirs: [] }] }),
            settings: { global: { [SETTING('agentRules.install')]: 'never' } },
            run: async (h) => { await h.manager().refreshAgentRules(); },
        },

        // --- syncSkills -------------------------------------------------------------------------------------
        {
            id: 'agents/sync-no-catalog', extensionPath: '<w>/extension-without-catalog', state: popupDone, seed: registeredSeeds,
            run: async (h) => { const m = h.manager(); return [await m.syncSkills('first'), await m.syncSkills('second')].map(u); },
        },
        {
            id: 'agents/sync-whole-catalog', about: 'every catalog skill into the personal roots (a Claude home exists): visible and hidden; foreign and earlier-installed skills; fx-broken fails on its own',
            folders: [{ name: 'wsA' }, { name: 'wsB' }, { name: 'remote', scheme: 'vscode-vfs' }],
            seed: {
                'home/.claude/': '',
                ...foreignSkill('home/.agents/skills', 'fx-gamma'),
                ...installedSkill('home/.agents/skills', 'old-skill'),
                ...installedSkill('home/.copilot/skills', 'fx-help'),
                ...installedSkill('wsB/.agents/skills', 'fx-beta', true),
                ...installedSkill('wsB/.claude/skills', 'fx-router'),
                ...foreignSkill('wsA/.agents/skills', 'theirs'),
            },
            run: async (h) => summariseReport(await h.manager().syncSkills('scenario')),
        },
        {
            id: 'agents/sync-no-extension-info', about: 'context.extension absent: markers carry "unknown"', noExtensionInfo: true,
            run: async (h) => summariseReport(await h.manager().syncSkills('scenario')),
        },
        {
            id: 'agents/sync-serialized', about: 'overlapping calls run one after the other; a rejection stays with its caller',
            ui: {
                beforeSync: async (n) => {
                    if (n === 1) { await new Promise((r) => realSetTimeout(r, 30)); throw new Error('scripted installer failure'); }
                },
            },
            run: async (h) => {
                const m = h.manager();
                const outcomes = await Promise.allSettled([m.syncSkills('first'), m.syncSkills('second'), m.syncSkills('third')]);
                return outcomes.map((o) => (o.status === 'fulfilled' ? { fulfilled: summariseReport(o.value) } : { rejected: describeError(o.reason) }));
            },
        },
    ];
}

// ===========================================================================
// Scenarios: debugConfigurationManager
// ===========================================================================

const LAUNCH_PLAIN = json({
    version: '0.2.0',
    configurations: [
        { name: 'A', type: 'gdbtarget', request: 'launch', program: '${workspaceFolder}/out/a.elf' },
        { type: 'x' },
        { name: 'B', type: 'cppdbg', request: 'attach', processId: 42 },
        { name: '', request: 'launch' },
    ],
});

const LAUNCH_JSONC = `{
    // Generated by the CMSIS Solution extension
    "version": "0.2.0",
    "configurations": [
        {
            "name": "CMSIS Debugger: pyOCD",
            "type": "gdbtarget",
            "request": "launch",
            "cwd": "\${workspaceFolder}/",
            /* the GDB from the Arm toolchain */
            "program": "out/app.elf",
            "gdb": "arm-none-eabi-gdb",
            "target": { "server": "pyocd", "port": "3333", },
            "cmsis": { "cbuildRunFile": "app+board.cbuild-run.yml" },
            "docs": "https://example.invalid/docs//path", // a URL with slashes
        },
        { "name": "Second", "type": "gdbtarget", "request": "attach", },
    ],
}
`;

function debugConfigScenarios() {
    const DCM = load('utils/debugConfigurationManager.js');
    const make = () => new DCM.DebugConfigurationManager();
    const files = {
        'src/main.py': 'print("x")\n',
        'src/test_x.py': 'import unittest\n\nclass TestX(unittest.TestCase):\n    def test_a(self):\n        pass\n',
        'src/test_plain.py': 'def test_a():\n    pass\n',
        'src/test_comment.py': '# a subclass Foo is documented here\nclass lower: pass\nclass Real:\n    pass\n',
        'src/Test_upper.PY': 'class Upper:\n    pass\n',
        'launch-plain/.vscode/launch.json': LAUNCH_PLAIN,
        'launch-jsonc/.vscode/launch.json': LAUNCH_JSONC,
        'launch-null/.vscode/launch.json': json({ configurations: [null, { name: 'A', type: 'x', request: 'launch' }] }),
        'launch-empty/.vscode/launch.json': '',
        'launch-no-configurations/.vscode/launch.json': json({ version: '0.2.0' }),
        'launch-empty-list/.vscode/launch.json': json({ configurations: [] }),
        'launch-invalid/.vscode/launch.json': 'this is { not json',
        'launch-not-array/.vscode/launch.json': json({ configurations: { name: 'A' } }),
        'launch-buffer/.vscode/launch.json': json({ configurations: [{ name: 'OnDisk', type: 'x', request: 'launch' }] }),
        'no-launch/': '',
    };
    const representative = ['main.py', 'app.js', 'app.ts', 'comp.jsx', 'comp.tsx', 'Main.java', 'Program.cs', 'main.go', 'main.c', 'util.cc',
        'main.cpp', 'MAIN.C', 'main.CPP', 'lib.rs', 'index.php', 'app.rb', 'notes.xyz', 'Makefile', 'archive.tar.gz'];
    const pickLabel = (label) => (items) => { const i = items.findIndex((it) => it.label === label); return i < 0 ? undefined : i; };
    return [
        {
            id: 'launch/detect-language',
            run: async () => {
                const dcm = make();
                const out = {};
                for (const f of [...representative, 'X.C', 'noext', '.hidden', 'dir.py/file']) { out[f] = dcm.detectLanguageFromFilePath(`/p/${f}`); }
                return out;
            },
        },
        {
            id: 'launch/default-configurations', about: 'sentinel name: synthesized for each file type; cwd is the file directory, not workingDirectory',
            seed: files,
            run: async (h) => {
                const dcm = make();
                const out = [];
                for (const f of representative) {
                    out.push(await attempt(`getDebugConfig(work, src/${f}, 'Default Configuration')`, () => dcm.getDebugConfig(h.path('work'), h.path(`src/${f}`), 'Default Configuration')));
                }
                out.push(await attempt('getDebugConfig(launch-plain, main.c, "Default Configuration") ignores launch.json', () => dcm.getDebugConfig(h.path('launch-plain'), '/p/main.c', 'Default Configuration')));
                return out;
            },
        },
        {
            id: 'launch/test-configurations', seed: files,
            run: async (h) => {
                const dcm = make();
                const cases = [
                    ['src/test_x.py', 'test_a'], ['src/test_x.py', 'TestY.test_b'], ['src/test_plain.py', 'test_a'],
                    ['src/test_comment.py', 'test_a'], ['src/Test_upper.PY', 'test_a'], ['src/missing_test.py', 'test_a'],
                    ['src/a.test.js', 'adds'], ['src/a.spec.ts', 'adds'], ['src/a.ts', 'adds'], ['src/comp.jsx', 'renders'],
                    ['src/Foo.java', 'bar'], ['src/P.cs', 't'], ['src/m.go', 't'], ['src/main.c', 't'], ['src/main.cpp', 't'],
                    ['src/lib.rs', 't'], ['src/x.php', 't'], ['src/x.rb', 't'], ['src/x.xyz', 't'], ['src/main.py', ''],
                ];
                const out = [];
                for (const [f, t] of cases) {
                    out.push(await attempt(`getDebugConfig(work, ${f}, 'Default Configuration', ${JSON.stringify(t)})`, () => dcm.getDebugConfig(h.path('work'), h.path(f), 'Default Configuration', t)));
                }
                out.push(await attempt('getDebugConfig(work, src/test_x.py, undefined, test_a) without launch.json', () => dcm.getDebugConfig(h.path('work'), h.path('src/test_x.py'), undefined, 'test_a')));
                return out;
            },
        },
        {
            id: 'launch/named-configurations', about: 'reading .vscode/launch.json through the document model (JSONC parser)',
            seed: files,
            run: async (h) => {
                S.openOverrides.set(h.path('launch-buffer/.vscode/launch.json'), json({ configurations: [{ name: 'Unsaved', type: 'x', request: 'launch' }] }));
                const dcm = make();
                const f = h.path('src/main.c');
                const cases = [
                    ['launch-plain', 'A'], ['launch-plain', 'B'], ['launch-plain', 'Missing'], ['launch-plain', undefined], ['launch-plain', ''],
                    ['launch-plain', 'Unnamed Configuration'],
                    ['launch-jsonc', 'CMSIS Debugger: pyOCD'], ['launch-jsonc', 'Second'],
                    ['launch-null', 'A'], ['launch-empty', 'A'], ['launch-no-configurations', 'A'], ['launch-empty-list', 'A'],
                    ['launch-invalid', 'A'], ['launch-not-array', 'A'], ['no-launch', 'A'],
                    ['launch-buffer', 'Unsaved'], ['launch-buffer', 'OnDisk'],
                ];
                const out = [];
                for (const [dir, name] of cases) {
                    out.push(await attempt(`getDebugConfig(${dir}, src/main.c, ${JSON.stringify(name) ?? 'undefined'})`, () => dcm.getDebugConfig(h.path(dir), f, name)));
                }
                return out;
            },
        },
        {
            id: 'launch/prompt', about: 'the configuration quick-pick: items, options and the scripted choice',
            seed: files,
            run: async (h) => {
                const dcm = make();
                const script = [
                    ['launch-plain', pickLabel('A')],
                    ['launch-plain', (items) => 1],
                    ['launch-plain', pickLabel('Default Configuration')],
                    ['launch-plain', () => undefined],
                    ['launch-jsonc', pickLabel('CMSIS Debugger: pyOCD')],
                    ['no-launch', pickLabel('Default Configuration')],
                    ['launch-empty', () => 0],
                    ['launch-invalid', () => 0],
                    ['launch-null', () => 0],
                    ['launch-buffer', () => 0],
                ];
                S.openOverrides.set(h.path('launch-buffer/.vscode/launch.json'), json({ configurations: [{ name: 'Unsaved', type: 'x' }] }));
                const out = [];
                for (const [dir, choose] of script) {
                    S.ui.pick = choose;
                    out.push(await attempt(`promptForConfiguration(${dir})`, () => dcm.promptForConfiguration(h.path(dir))));
                }
                return out;
            },
        },
        {
            id: 'launch/folder-members', seed: files,
            run: async (h) => {
                const dcm = make();
                const folder = (dir) => ({ uri: fileUri(h.path(dir)), name: dir, index: 0 });
                const out = [];
                for (const dir of ['launch-plain', 'launch-jsonc', 'launch-null', 'launch-invalid', 'no-launch']) {
                    out.push(await attempt(`getAvailableConfigurations(${dir})`, () => dcm.getAvailableConfigurations(folder(dir))));
                    out.push(await attempt(`hasLaunchJson(${dir})`, () => dcm.hasLaunchJson(folder(dir))));
                }
                out.push(await attempt('validateWorkspace({uri: /x})', () => dcm.validateWorkspace({ uri: fileUri('/x'), name: 'x', index: 0 })));
                out.push(await attempt('validateWorkspace({uri: ""})', () => dcm.validateWorkspace({ uri: fileUri(''), name: 'x', index: 0 })));
                out.push(await attempt('validateWorkspace(undefined)', () => dcm.validateWorkspace(undefined)));
                out.push(await attempt('validateWorkspace(null)', () => dcm.validateWorkspace(null)));
                out.push(await attempt('validateWorkspace({})', () => dcm.validateWorkspace({})));
                out.push(await attempt('validateWorkspace({uri: {}})', () => dcm.validateWorkspace({ uri: {} })));
                out.push(await attempt('DebugConfigurationManager.getAutoLaunchConfigName()', () => DCM.DebugConfigurationManager.getAutoLaunchConfigName()));
                out.push(await attempt('exports', () => Object.keys(DCM).sort()));
                return out;
            },
        },
        {
            id: 'launch/without-uri-joinpath', about: 'the transport stub has no Uri.joinPath (surface snapshot pins the TypeError)',
            seed: files,
            run: async (h) => {
                const saved = api.Uri.joinPath;
                delete api.Uri.joinPath;
                try {
                    const dcm = make();
                    S.ui.pick = () => 0;
                    const folder = { uri: fileUri(h.path('launch-plain')), name: 'launch-plain', index: 0 };
                    return [
                        await attempt('promptForConfiguration(launch-plain)', () => dcm.promptForConfiguration(h.path('launch-plain'))),
                        await attempt('getDebugConfig(launch-plain, src/main.c, "A")', () => dcm.getDebugConfig(h.path('launch-plain'), h.path('src/main.c'), 'A')),
                        await attempt('getAvailableConfigurations(launch-plain)', () => dcm.getAvailableConfigurations(folder)),
                        await attempt('hasLaunchJson(launch-plain)', () => dcm.hasLaunchJson(folder)),
                    ];
                } finally {
                    api.Uri.joinPath = saved;
                }
            },
        },
    ];
}

// ===========================================================================
// Scenarios: extension activate / deactivate
// ===========================================================================

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

function holdPort(port) {
    return new Promise((resolve, reject) => {
        const s = net.createServer((sock) => sock.destroy());
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
    });
}

function canBind(port) {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
}

function labelOf(d) {
    return d && typeof d.label === 'string' ? d.label : `<${d?.constructor?.name ?? typeof d}>`;
}

function describeProviders(m) {
    return S.providers.map(({ id, provider }) => {
        const describe = (defs) => defs.map((d) => ({
            class: d?.constructor?.name,
            label: d.label,
            uri: String(d.uri),
            headers: explicit(d.headers),
            version: d.version === m.de.SERVER_VERSION ? '<SERVER_VERSION>' : d.version,
        }));
        const first = provider.provideMcpServerDefinitions();
        const second = provider.provideMcpServerDefinitions();
        return {
            id,
            provideMcpServerDefinitions: typeof provider.provideMcpServerDefinitions,
            resolveMcpServerDefinition: typeof provider.resolveMcpServerDefinition,
            onDidChangeMcpServerDefinitions: typeof provider.onDidChangeMcpServerDefinitions,
            definitions: describe(first),
            secondCallEqual: JSON.stringify(describe(first)) === JSON.stringify(describe(second)),
            sameUriObjectAcrossCalls: first[0]?.uri === second[0]?.uri,
        };
    });
}

async function activateRecorded(h, ext, m) {
    S.reads = new Map();
    S.captureTimers = true;
    step('activate');
    let outcome;
    try {
        outcome = { resolved: u(await ext.activate(h.ctx)) };
    } catch (e) {
        outcome = { rejected: describeError(e) };
    }
    S.captureTimers = false;
    const reads = [...S.reads.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    S.reads = null;
    await settle();
    const contributed = packageContributions().commands.map((cmd) => cmd.command);
    const registered = [...S.commands.keys()];
    return {
        ...outcome,
        settingsRead: reads,
        commands: registered,
        registeredButNotContributed: registered.filter((id) => !contributed.includes(id)),
        contributedButNotRegistered: contributed.filter((id) => !registered.includes(id)),
        subscriptions: h.ctx.subscriptions.map(labelOf),
        mcpServerDefinitionProviders: describeProviders(m),
        timers: S.timers.map((t) => t.ms),
        tmpdir: dumpTmp(),
    };
}

async function configChange(keys) {
    step(`configuration change: ${keys.join(' + ')}`);
    const affects = (section) => keys.some((k) => k === section || k.startsWith(`${section}.`) || section.startsWith(`${k}.`));
    const errors = await fire('workspace.onDidChangeConfiguration', { affectsConfiguration: affects });
    if (errors.length > 0) { emit({ ev: 'listenerErrors', errors }); }
}

async function fireTimer() {
    step('setup timer fires');
    const t = S.timers.shift();
    if (!t) { emit({ ev: 'noTimer' }); return; }
    try { await t.fn(...t.args); } catch (e) { emit({ ev: 'timerThrew', error: describeError(e) }); }
}

async function runCommand(id) {
    step(`command ${id}`);
    const handler = S.commands.get(id);
    if (!handler) { emit({ ev: 'commandMissing', id }); return; }
    try { await handler(); } catch (e) { emit({ ev: 'commandThrew', id, error: describeError(e) }); }
}

async function deactivateRecorded(ext, port) {
    step('deactivate');
    let outcome;
    try { outcome = { resolved: u(await ext.deactivate()) }; } catch (e) { outcome = { rejected: describeError(e) }; }
    await settle();
    const after = { ...outcome, tmpdir: dumpTmp() };
    if (port !== undefined) { after.routerPortFreeAgain = await canBind(port); }
    step('deactivate again');
    try { after.second = { resolved: u(await ext.deactivate()) }; } catch (e) { after.second = { rejected: describeError(e) }; }
    return after;
}

/** The static half of the contract: what package.json contributes for the extension entry point. */
function packageContributions() {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const c = pkg.contributes ?? {};
    const configuration = (Array.isArray(c.configuration) ? c.configuration : [c.configuration ?? {}])
        .flatMap((section) => Object.entries(section.properties ?? {}))
        .map(([key, v]) => ({ key, type: v.type, default: explicit(v.default), ...(v.scope ? { scope: v.scope } : {}) }));
    return {
        main: pkg.main,
        activationEvents: pkg.activationEvents,
        mcpServerDefinitionProviders: c.mcpServerDefinitionProviders,
        commands: (c.commands ?? []).map((cmd) => ({ command: cmd.command, title: cmd.title, category: cmd.category })),
        commandPalette: c.menus?.commandPalette ?? [],
        configuration,
    };
}

/**
 * The Serial Monitor (ms-vscode.vscode-serial-monitor 0.13), active: its
 * exports hold only getApi(version, context), which accepts version 0 and
 * throws without the caller's extension context. Every request is recorded.
 */
function fakeSerialMonitor() {
    const requests = [];
    const extension = {
        id: 'ms-vscode.vscode-serial-monitor',
        isActive: true,
        exports: {
            getApi(version, context) {
                requests.push({ version: u(version), context: context === S.context ? '<context>' : explicit(context), extensionId: u(context?.extension?.id) });
                if (version !== 0) { throw new Error('Invalid serial monitor API version.'); }
                if (!context) { throw new Error('In order to use this API, you must pass your extension\'s extensionContext.'); }
                return { listAvailablePorts: async () => [], startMonitoringPort: async () => undefined, stopMonitoringPort: async () => true, dispose() {} };
            },
        },
        activate: async () => extension.exports,
    };
    return { extension, requests };
}

/**
 * Ask the window's Serial Monitor bridge for its status when the coordinator
 * is first started, that is before the MCP server serves the serial tools.
 */
function probeSerialMonitorAtStart(m, monitor) {
    const bridge = load('core/serialMonitorBridge.js').serialMonitorBridge;
    const startServing = m.wc.WindowCoordinator.prototype.start;
    const probe = {};
    let probed = false;
    m.wc.WindowCoordinator.prototype.start = function (...a) {
        if (probed) { return startServing.apply(this, a); }
        probed = true;
        return bridge.status().then((status) => {
            probe.status = explicit(status);
            probe.getApi = monitor.requests.slice();
            return startServing.apply(this, a);
        });
    };
    return probe;
}

function extensionScenarios() {
    const fakeSession = { id: 'session-1', name: 'fake', type: 'gdbtarget', configuration: { name: 'fake', type: 'gdbtarget', request: 'launch' }, customRequest: async () => ({}) };
    return [
        { id: 'extension/package-contributions', about: 'package.json: entry point, provider id, commands, palette, settings defaults', run: async () => packageContributions() },
        {
            id: 'extension/activate-router', about: 'fallback settings except the port; first run; the Serial Monitor\'s API as the coordinator starts; the listeners, commands and timer driven afterwards',
            seed: agentSeeds({ cline: json({ mcpServers: { [LEGACY]: { type: 'streamableHttp', url: URL_3001 } } }) }),
            ui: {
                agents: seq(['Claude Code'], null),
                message: (() => { let reloads = 0; return (ev) => (/server port setting changed/.test(ev.message) && reloads++ === 0 ? 0 : undefined); })(),
            },
            run: async (h) => {
                clearTmp();
                const port = await freePort();
                PORTS.add(port);
                S.settings.global.set(SETTING('serverPort'), port);
                const monitor = fakeSerialMonitor();
                S.ui = { ...S.ui, extension: (id) => (id === monitor.extension.id ? monitor.extension : undefined) };
                const { ext, m } = loadExtension();
                // F14: the bridge reaches the API only with this extension's context, handed over before the tools are served.
                const serialMonitorAtCoordinatorStart = probeSerialMonitorAtStart(m, monitor);
                const out = { activation: await activateRecorded(h, ext, m), serialMonitorAtCoordinatorStart };
                step('debug session terminates');
                await fire('debug.onDidTerminateDebugSession', fakeSession);
                for (const keys of [
                    [SETTING('agentRules.install')],
                    [SETTING('packDocs.extractor')],
                    [SETTING('serverPort')],
                    [SETTING('buildInfo.enabled')],
                    [SETTING('packDocs.enabled')],
                    [SETTING('serverPort'), SETTING('packDocs.enabled')],
                    [SETTING('serial.enabled')],
                    [SETTING('timeoutInSeconds')],
                    [SETTING('telemetry.jsonlPath')],
                    ['cmsis-developer-assistant'],
                    ['cmsis-csolution.packRoot'],
                ]) {
                    await configChange(keys);
                }
                step('workspace folder added');
                S.folders = [makeFolder(h.w, { name: 'wsA' }, 0)];
                await fire('workspace.onDidChangeWorkspaceFolders', { added: [S.folders[0]], removed: [] });
                await fireTimer();
                await runCommand('cmsis-developer-assistant.resetPopupState');
                await runCommand('cmsis-developer-assistant.configure');
                out.deactivation = await deactivateRecorded(ext, port);
                return out;
            },
        },
        {
            id: 'extension/activate-worker', about: 'router port taken; every setting non-default; duplicate extension installed; the timer with the setup answered',
            folders: [{ name: 'ws' }],
            state: { [POPUP_KEY]: true },
            seed: agentSeeds({ 'claude-code': json({ mcpServers: { [KEY]: { type: 'http', url: URL_3001 } } }) }),
            settings: {
                global: {
                    [SETTING('timeoutInSeconds')]: 42,
                    [SETTING('dapRequestTimeoutMs')]: 1111,
                    [SETTING('memoryReadTimeoutMs')]: 2222,
                    [SETTING('telemetry.jsonlPath')]: '  rel/t.jsonl  ',
                    [SETTING('serial.enabled')]: false,
                    [SETTING('packDocs.enabled')]: true,
                    [SETTING('buildInfo.enabled')]: true,
                },
            },
            ui: {
                extension: (id) => (id === 'arm.cmsis-pack-docs' ? { id, isActive: false, exports: undefined } : undefined),
            },
            run: async (h) => {
                clearTmp();
                const port = await freePort();
                PORTS.add(port);
                const blocker = await holdPort(port);
                try {
                    S.settings.global.set(SETTING('serverPort'), port);
                    const { ext, m } = loadExtension();
                    const out = { activation: await activateRecorded(h, ext, m) };
                    await fireTimer();
                    out.deactivation = await deactivateRecorded(ext);
                    return out;
                } finally {
                    await new Promise((r) => blocker.close(() => r()));
                }
            },
        },
        {
            id: 'extension/activate-start-fails', about: 'coordinator.start rejects (injected); relative telemetry path without a folder; absolute path variant in settings',
            seed: agentSeeds({ cline: json({ mcpServers: { [LEGACY]: { type: 'streamableHttp', url: URL_3001 } } }) }),
            settings: { global: { [SETTING('telemetry.jsonlPath')]: 'rel/t.jsonl', [SETTING('timeoutInSeconds')]: 7 } },
            run: async (h) => {
                clearTmp();
                const port = await freePort();
                PORTS.add(port);
                S.settings.global.set(SETTING('serverPort'), port);
                S.failStart = true;
                const { ext, m } = loadExtension();
                const out = { activation: await activateRecorded(h, ext, m) };
                out.deactivation = await deactivateRecorded(ext);
                return out;
            },
        },
        {
            id: 'extension/activate-under-test-runner', about: 'extensionMode Test (npm test): no skill sync, migration, coordinator or setup timer; the commands still register',
            extensionMode: 3,
            seed: agentSeeds({ cline: json({ mcpServers: { [LEGACY]: { type: 'streamableHttp', url: URL_3001 } } }) }),
            run: async (h) => {
                clearTmp();
                const { ext, m } = loadExtension();
                const out = { activation: await activateRecorded(h, ext, m) };
                await configChange(['cmsis-developer-assistant.agentRules.install']);
                await fireTimer();
                out.deactivation = await deactivateRecorded(ext);
                return out;
            },
        },
        {
            id: 'extension/activate-absolute-telemetry', about: 'absolute telemetry path (trimmed) and the timer with the popup already answered, no agents',
            state: { [POPUP_KEY]: true },
            run: async (h) => {
                clearTmp();
                const port = await freePort();
                PORTS.add(port);
                S.settings.global.set(SETTING('serverPort'), port);
                S.settings.global.set(SETTING('telemetry.jsonlPath'), ` ${h.path('telemetry/t.jsonl')} `);
                const { ext, m } = loadExtension();
                const out = { activation: await activateRecorded(h, ext, m) };
                await fireTimer();
                out.deactivation = await deactivateRecorded(ext, port);
                return out;
            },
        },
    ];
}

// ===========================================================================
// Main
// ===========================================================================

/**
 * `--check-fence`: prove that the isolation check notices a path variable
 * pointing outside the sandbox and that the write fence refuses writes
 * outside it (and that nothing gets created there).
 */
async function checkFence() {
    const results = [];
    const expect = (label, ok) => results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}`);

    process.env.CODEX_HOME = path.join(REAL_TMPDIR, `cda-isolation-probe-${process.pid}`);
    expect('isolation check reports $CODEX_HOME outside the sandbox', isolationProblems().some((p) => p.startsWith('$CODEX_HOME')));
    delete process.env.CODEX_HOME;
    expect('isolation check is clean otherwise', isolationProblems().length === 0);
    expect('os.homedir() is inside the sandbox', isInside(os.homedir(), ROOT));

    const target = path.join(REAL_TMPDIR, `cda-fence-probe-${process.pid}`);
    const inside = path.join(ROOT, 'fence-probe');
    fs.writeFileSync(inside, 'inside');
    expect('a write inside the sandbox is allowed', fs.readFileSync(inside, 'utf8') === 'inside');
    const refused = async (label, fn) => {
        let code;
        try { await fn(); } catch (e) { code = e.code; }
        expect(`${label} outside the sandbox is refused`, code === 'EACCES');
    };
    await refused('fs.writeFileSync', () => fs.writeFileSync(target, 'x'));
    await refused('fs.promises.writeFile', () => fs.promises.writeFile(target, 'x'));
    await refused('fs.appendFile (callback)', () => new Promise((resolve, reject) => fs.appendFile(target, 'x', (e) => (e ? reject(e) : resolve()))));
    await refused('fs.mkdirSync', () => fs.mkdirSync(target, { recursive: true }));
    await refused('fs.promises.rename into it', () => fs.promises.rename(inside, target));
    await refused('fs.promises.cp into it', () => fs.promises.cp(inside, target));
    await refused('fs.openSync(w)', () => fs.openSync(target, 'w'));
    await refused('fs.createWriteStream', () => fs.createWriteStream(target));
    expect('nothing was created outside the sandbox', !fs.existsSync(target));
    violations.length = 0;

    console.log(results.join('\n'));
    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    fenceOn = false;
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(failed > 0 ? 3 : 0);
}

function abort(message) {
    fenceOn = false;
    console.error(message);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(3);
}

async function main() {
    writeFixtureExtension();
    const t0 = Date.now();

    // Pure path helpers of collaborators this oracle does not cover; used only
    // by the isolation check, so a wrong redirection aborts before any run.
    helpers = {
        getSkillInstallRoots: load('utils/skillInstaller.js').getSkillInstallRoots,
        defaultPackRoot: load('core/packDocs/cbuildRun.js').defaultPackRoot,
        resolveUserDocsDir: load('core/packDocs/userDocs.js').resolveUserDocsDir,
    };
    ACM = load('utils/agentConfigurationManager.js');
    instrumentSkillInstaller(load('utils/skillInstaller.js'));
    installFence();
    if (argv.includes('--check-fence')) { await checkFence(); return; }

    const mute = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const silence = () => {
        for (const k of Object.keys(mute)) { console[k] = (...a) => LOG_LINES.push(`[${S.id ?? '-'}] console.${k} ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}`); }
    };
    const restore = () => Object.assign(console, mute);

    const defs = [...agentScenarios(), ...debugConfigScenarios(), ...extensionScenarios()];
    const selected = ONLY ? defs.filter((d) => d.id.includes(ONLY)) : defs;
    const scenarios = [];
    for (const def of selected) {
        silence();
        let record;
        try {
            record = await runScenario(def);
        } finally {
            restore();
        }
        scenarios.push(record);
        if (record.error || record.timedOut) { console.log(`  ${def.id}: ${record.timedOut ? 'TIMED OUT' : record.error}`); }
    }
    fenceOn = false;

    if (VERBOSE) { console.log(LOG_LINES.join('\n')); }
    if (violations.length > 0) {
        console.error(`WRITE FENCE: the code tried to write outside the sandbox (refused):\n  ${[...new Set(violations)].join('\n  ')}`);
        fs.rmSync(ROOT, { recursive: true, force: true });
        process.exit(3);
    }
    fs.rmSync(ROOT, { recursive: true, force: true });

    const actual = JSON.stringify({ format: 1, scenarios }, null, 2) + '\n';
    const took = `${((Date.now() - t0) / 1000).toFixed(1)} s`;
    if (ONLY) {
        console.log(actual);
        console.log(`${scenarios.length} scenario(s) matching "${ONLY}" (${took}); nothing compared`);
        process.exit(0);
    }
    if (UPDATE || !fs.existsSync(SNAPSHOT)) {
        fs.writeFileSync(SNAPSHOT, actual);
        console.log(`snapshot written: ${path.relative(process.cwd(), SNAPSHOT)} (${scenarios.length} scenarios, ${Buffer.byteLength(actual)} bytes, ${took})`);
        process.exit(0);
    }
    const expected = fs.readFileSync(SNAPSHOT, 'utf8');
    if (expected === actual) {
        console.log(`configuration behaviour identical to the snapshot (${scenarios.length} scenarios, ${Buffer.byteLength(actual)} bytes, ${took})`);
        process.exit(0);
    }
    const a = expected.split('\n');
    const b = actual.split('\n');
    const first = a.findIndex((line, i) => line !== b[i]);
    let scenario = '?';
    for (let i = first; i >= 0; i--) {
        const m = /^ {6}"id": "([^"]+)"/.exec(b[i] ?? '');
        if (m) { scenario = m[1]; break; }
    }
    console.log(`CONFIGURATION BEHAVIOUR CHANGED — first difference at snapshot line ${first + 1} (scenario ${scenario}):`);
    console.log(`  expected: ${a[first]}`);
    console.log(`  actual:   ${b[first]}`);
    const out = path.join(REAL_TMPDIR, 'config-scenarios.actual.json');
    fs.writeFileSync(out, actual);
    console.log(`full actual record written to ${out}; diff it against ${path.relative(process.cwd(), SNAPSHOT)}`);
    process.exit(1);
}

main().catch((err) => {
    fenceOn = false;
    console.error('harness error:', err);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(2);
});
