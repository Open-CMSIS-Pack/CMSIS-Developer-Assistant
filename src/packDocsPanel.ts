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
 * A debug webview for the experiment (host code, not merged):
 *
 *  - Target: the cbuild-run context (or pack + device), its resolution and
 *    core, every document the tools would see (pack, web, Arm catalogue,
 *    workspace) with its cache state and one-click fetch / browse / run,
 *    and the SVD with its groups, instances, registers and interrupts;
 *  - Store: what the cache holds — metadata, fetch record, chapter index,
 *    index statistics and page text per extracted document;
 *  - Tools: any of the tools, run in-process with hand-written arguments.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BuildInfoHandler } from './buildInfoHandler';
import { CachedDoc, PackDocsLog, TargetArgs, buildChapterIndex, docState } from './core/packDocs';
import { PackDocsHandler } from './packDocsHandler';

interface ToolSpec {
    name: string;
    template: object;
    run: (args: never) => Promise<string>;
}

function tools(docs: PackDocsHandler, build: BuildInfoHandler | undefined): ToolSpec[] {
    const list: ToolSpec[] = [
        { name: 'list_target_docs', template: {}, run: (a) => docs.handleListTargetDocs(a) },
        { name: 'search_target_docs', template: { query: 'GPIOA clock enable', limit: 8 }, run: (a) => docs.handleSearchTargetDocs(a) },
        { name: 'read_doc_pages', template: { doc: '', pages: '1' }, run: (a) => docs.handleReadDocPages(a) },
        { name: 'fetch_doc', template: { doc: 'ihi0031' }, run: (a) => docs.handleFetchDoc(a) },
        { name: 'get_peripheral_docs', template: { peripheral: 'USART1', aspects: ['chapters', 'registers', 'clock', 'irq', 'errata'] }, run: (a) => docs.handleGetPeripheralDocs(a) },
    ];
    if (build) {
        list.push(
            { name: 'list_build_artifacts', template: {}, run: (a) => build.handleListBuildArtifacts(a) },
            { name: 'get_memory_usage', template: { top: 20 }, run: (a) => build.handleGetMemoryUsage(a) },
            { name: 'lookup_symbol', template: { name: 'main' }, run: (a) => build.handleLookupSymbol(a) },
            { name: 'get_section_layout', template: {}, run: (a) => build.handleGetSectionLayout(a) },
            { name: 'get_build_diagnostics', template: { limit: 20 }, run: (a) => build.handleGetBuildDiagnostics(a) },
        );
    }
    return list;
}

function targetArgsOf(m: { [k: string]: unknown }): TargetArgs {
    const a = (m.args ?? {}) as Record<string, unknown>;
    const pick = (k: string) => (typeof a[k] === 'string' && (a[k] as string).trim() ? { [k]: (a[k] as string).trim() } : {});
    return { ...pick('target'), ...pick('pack'), ...pick('device'), ...pick('board') } as TargetArgs;
}

export class PackDocsPanel {
    private static current: PackDocsPanel | undefined;

    static show(context: vscode.ExtensionContext, docs: PackDocsHandler, build: BuildInfoHandler | undefined, log: PackDocsLog): void {
        if (PackDocsPanel.current) {
            PackDocsPanel.current.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel('cmsisPackDocsPanel', 'CMSIS Pack Docs', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        PackDocsPanel.current = new PackDocsPanel(panel, docs, build, log);
        context.subscriptions.push(panel);
    }

    private readonly specs: ToolSpec[];

    private constructor(private readonly panel: vscode.WebviewPanel, private readonly docs: PackDocsHandler, build: BuildInfoHandler | undefined, private readonly log: PackDocsLog) {
        this.specs = tools(docs, build);
        panel.webview.html = this.html();
        panel.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => void this.onMessage(m));
        panel.onDidDispose(() => { PackDocsPanel.current = undefined; });
    }

    private post(message: object): void {
        void this.panel.webview.postMessage(message);
    }

    private entries(): CachedDoc[] {
        return this.docs.getStore().listCached();
    }

    private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
        try {
            switch (m.type) {
                case 'target.contexts': {
                    const contexts = await this.docs.listContexts();
                    this.post({
                        type: 'target.contexts',
                        contexts: contexts.map(c => ({
                            file: c.file,
                            name: path.basename(c.file).replace(/\.cbuild-run\.yml$/, ''),
                            targetType: c.targetType,
                            device: c.device?.name,
                            devicePack: c.devicePack ? `${c.devicePack.vendor}::${c.devicePack.name}@${c.devicePack.version ?? ''}` : undefined,
                            board: c.board?.name,
                        })),
                    });
                    return;
                }
                case 'target.inspect': {
                    const t0 = Date.now();
                    const args = targetArgsOf(m);
                    const r = await this.docs.inspectTarget(args);
                    this.post({
                        type: 'target.inspect',
                        args,
                        error: r.error,
                        resolution: r.resolution,
                        processors: r.processors,
                        device: r.device,
                        devicePack: r.devicePack,
                        workspaceDirs: r.workspaceDirs,
                        docs: r.docs.map(d => ({
                            id: d.id, title: d.title, scope: d.scope, source: d.source, kind: d.kind, category: d.category, url: d.url, path: d.path,
                            cached: d.cached, indexed: d.indexed, pages: d.pages, revision: d.revision, format: d.format, missing: d.missing, unsupported: d.unsupported,
                            readable: !d.missing && !d.unsupported && !!d.path && (d.source !== 'web' || (d.cached && d.format !== 'html')),
                            state: docState(d),
                        })),
                        svd: r.svd,
                        core: r.core,
                        coreDiag: r.coreDiag,
                        npu: r.npu,
                        ms: Date.now() - t0,
                    });
                    return;
                }
                case 'target.peripheral': {
                    const name = String(m.name ?? '');
                    const src = m.src === 'core' ? 'core' : m.src === 'npu' ? 'npu' : 'svd';
                    const r = src === 'core' ? await this.docs.inspectCorePeripheral(targetArgsOf(m), name)
                        : src === 'npu' ? await this.docs.inspectNpuPeripheral(targetArgsOf(m), name)
                            : await this.docs.inspectPeripheral(targetArgsOf(m), name);
                    this.log.info(`[debug panel] ${src} peripheral ${name}: ${'error' in r ? r.error : `${r.registers.length} registers, ${r.peripheral.interrupts.length} interrupts`}`);
                    this.post({ type: 'target.peripheral', name, src, ...r });
                    return;
                }
                case 'store.list': {
                    const entries = this.entries();
                    const fetched = this.docs.getStore().listFetched().filter(f => !entries.some(e => e.id === f.id));
                    this.post({
                        type: 'store.list',
                        storageDir: this.docs.getStore().dir,
                        entries: entries.map(e => ({ ...e, fetch: undefined, hasFetch: !!e.fetch })),
                        fetchedOnly: fetched.map(f => ({ id: f.id, title: f.title, url: f.url, format: f.format, revision: f.revision })),
                    });
                    return;
                }
                case 'store.detail': {
                    const entry = this.entries().find(e => e.id === m.id);
                    if (!entry) { this.post({ type: 'error', text: `no cached document ${m.id}` }); return; }
                    const t0 = Date.now();
                    const store = this.docs.getStore();
                    const pages = store.readCachedPages(entry);
                    const index = store.readCachedIndex(entry);
                    const chapters = buildChapterIndex(pages);
                    const tokens = Object.keys(index.postings);
                    const byPages = tokens.map(t => ({ token: t, pages: index.postings[t].length / 2 })).sort((a, b) => b.pages - a.pages).slice(0, 40);
                    this.post({
                        type: 'store.detail',
                        into: typeof m.into === 'string' ? m.into : 'detail',
                        id: entry.id,
                        meta: JSON.parse(fs.readFileSync(entry.metaPath, 'utf-8')) as object,
                        fetch: entry.fetch,
                        chapters: chapters.map(c => ({ number: c.number, title: c.title, acronyms: c.acronyms, start: c.start, end: c.end, sections: c.sections.length })),
                        index: { tokens: tokens.length, pages: index.pageCount, avgLength: Math.round(index.lengths.reduce((a, b) => a + b, 0) / Math.max(1, index.lengths.length)), top: byPages },
                        pagesWithHeading: pages.filter(p => p.heading).length,
                        ms: Date.now() - t0,
                    });
                    return;
                }
                case 'store.page': {
                    const entry = this.entries().find(e => e.id === m.id);
                    if (!entry) { this.post({ type: 'error', text: `no cached document ${m.id}` }); return; }
                    const pages = this.docs.getStore().readCachedPages(entry);
                    const p = Math.min(Math.max(Number(m.page) || 1, 1), pages.length);
                    const rec = pages[p - 1];
                    this.post({ type: 'store.page', into: typeof m.into === 'string' ? m.into : 'detail', id: entry.id, page: p, of: pages.length, heading: rec?.heading ?? '', text: rec?.text ?? '' });
                    return;
                }
                case 'store.open': {
                    const file = String(m.path ?? '');
                    if (!file) { return; }
                    if (/^https?:\/\//i.test(file)) { await vscode.env.openExternal(vscode.Uri.parse(file)); return; }
                    if (/\.(json|jsonl|md|txt|log|yml|yaml|svd|xml|map)$/i.test(file)) {
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: true });
                    } else {
                        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
                    }
                    return;
                }
                case 'command': {
                    await vscode.commands.executeCommand(String(m.command ?? ''));
                    // The import command changes the store and the target's document set.
                    this.post({ type: 'refresh' });
                    return;
                }
                case 'tools.list': {
                    this.post({ type: 'tools.list', tools: this.specs.map(s => ({ name: s.name, template: s.template })) });
                    return;
                }
                case 'tool.run': {
                    const spec = this.specs.find(s => s.name === m.tool);
                    if (!spec) { this.post({ type: 'error', text: `unknown tool ${m.tool}` }); return; }
                    let args: object;
                    try {
                        args = m.args ? JSON.parse(String(m.args)) as object : {};
                    } catch (e) {
                        this.post({ type: 'tool.result', tool: spec.name, args: m.args, text: `arguments are not JSON: ${e instanceof Error ? e.message : e}`, ms: 0 });
                        return;
                    }
                    const t0 = Date.now();
                    this.log.info(`[debug panel] ${spec.name} ${JSON.stringify(args)}`);
                    const text = await spec.run(args as never);
                    this.post({ type: 'tool.result', tool: spec.name, args: JSON.stringify(args), text, ms: Date.now() - t0 });
                    return;
                }
                default:
                    this.post({ type: 'error', text: `unknown message ${m.type}` });
            }
        } catch (e) {
            this.log.error('debug panel', e);
            this.post({ type: 'error', text: e instanceof Error ? e.stack ?? e.message : String(e) });
        }
    }

    private html(): string {
        const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>CMSIS Pack Docs</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; }
  .tabs { display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 2; }
  .tabs button { background: none; border: none; color: var(--vscode-foreground); padding: 4px 10px; cursor: pointer; border-bottom: 2px solid transparent; font: inherit; }
  .tabs button.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  .view { display: none; } .view.active { display: block; }
  #store { display: grid; grid-template-columns: minmax(280px, 34%) 1fr; height: calc(100vh - 40px); }
  #list { overflow: auto; border-right: 1px solid var(--vscode-panel-border); }
  #detail, #target, #tools { overflow: auto; padding: 8px 12px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 2px 6px; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border); }
  th { position: sticky; top: 0; background: var(--vscode-editor-background); }
  tr.row { cursor: pointer; } tr.row:hover, tr.row.sel { background: var(--vscode-list-hoverBackground); }
  .muted { opacity: .7; } .mono { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 8px; margin: 4px 0 10px; max-height: 60vh; overflow: auto; }
  h3 { margin: 12px 0 4px; } h2 { margin: 6px 0; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  input, select, textarea, button.btn { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; font-family: inherit; font-size: inherit; }
  button.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  button.chip { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border: none; border-radius: 8px; padding: 1px 8px; margin: 2px; cursor: pointer; font: inherit; }
  button.chip.sel { outline: 2px solid var(--vscode-focusBorder); }
  .instances button.chip { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
  .instances button.chip .muted { color: #fff; opacity: .8; }
  .instances button.chip.sel { background: var(--vscode-charts-orange, #d18616); outline: none; }
  .periph { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.12)); border-left: 4px solid var(--vscode-charts-yellow, #d4b100); padding: 8px 12px; margin: 10px 0; border-radius: 0 4px 4px 0; }
  .periph h4 { margin: 10px 0 2px; font-weight: 600; }
  table.bits { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 2px 0 4px; }
  table.bits td { border: 1px solid var(--vscode-panel-border); padding: 1px 0; text-align: center; font-size: 10px; line-height: 1.3; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  table.bits tr.num td { border: none; opacity: .55; font-size: 9px; }
  table.bits td.f0 { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
  table.bits td.f1 { background: var(--vscode-charts-purple, #b180d7); color: #fff; }
  table.bits td.f2 { background: var(--vscode-charts-orange, #d18616); color: #fff; }
  table.bits td.u { opacity: .35; }
  table.fields td { border-bottom: none; padding: 0 6px; }
  textarea { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); min-height: 90px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
  .hist { margin-top: 10px; } .hist div { padding: 2px 0; }
  .badge { display: inline-block; padding: 0 5px; border-radius: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 90%; }
  .ok { color: var(--vscode-testing-iconPassed, #3c3); } .warn { color: var(--vscode-editorWarning-foreground, #cc3); }
  .act { white-space: nowrap; } .act a { margin-right: 6px; }
</style>
</head>
<body>
<div class="tabs">
  <button id="tabTarget" class="active">Target</button>
  <button id="tabStore">Store</button>
  <button id="tabTools">Tools</button>
  <span class="muted" id="status" style="margin-left:auto;padding:4px"></span>
</div>
<div id="target" class="view active">
  <div class="toolbar">
    <label>Context <select id="ctxSel"><option value="">(loading…)</option></select></label>
    <span id="ctxArgs" style="display:none">pack <input id="ctxPack" placeholder="Keil::STM32U5xx_DFP@2.1.0" size="30"> device <input id="ctxDevice" placeholder="STM32U585AIIx" size="18"></span>
    <button class="btn" id="inspectBtn">Inspect</button>
    <a id="ctxRefresh">rescan contexts</a>
    <span class="muted" id="inspectInfo"></span>
  </div>
  <div id="targetBody"><div class="muted">Pick a cbuild-run context of the workspace (or pack + device) and press Inspect: the resolution, the core, the SVD and every document the tools see, with its cache state.</div></div>
</div>
<div id="store" class="view">
  <div id="list"><div class="muted" style="padding:8px">loading…</div></div>
  <div id="detail"><div class="muted">Select a document. Columns: id, source, pages (or sections), size of the source file, when it was extracted.</div></div>
</div>
<div id="tools" class="view">
  <div class="toolbar">
    <label>Tool <select id="toolSel"></select></label>
    <button class="btn" id="runBtn">Run</button>
    <button class="btn" id="resetBtn">Template</button>
    <label><input type="checkbox" id="addTarget" checked> add the Target tab's context to the arguments</label>
    <span class="muted" id="runInfo"></span>
  </div>
  <textarea id="args" spellcheck="false">{}</textarea>
  <pre id="out" class="mono">Results appear here. Arguments are the tool's JSON input; target, pack and device work as in the MCP tools.</pre>
  <div class="hist" id="hist"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const kb = (n) => n === undefined || n === null ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' kB' : n + ' B';
  const hex = (n) => '0x' + Number(n).toString(16).toUpperCase().padStart(8, '0');
  let entries = [], selected, templates = {}, history = [], storeMsg;
  let contexts = [], inspection, targetIds = new Set(), docFilter = '', docSource = '';
  const sel = { svd: { group: undefined, instance: undefined, groups: new Map() }, core: { group: undefined, instance: undefined, groups: new Map() }, npu: { group: undefined, instance: undefined, groups: new Map() } };
  function peripheralSection(src, list) {
    const st = sel[src];
    st.groups = new Map();
    for (const p of list) { const g = p.group || p.name.replace(/\d+$/, ''); if (!st.groups.has(g)) st.groups.set(g, []); st.groups.get(g).push(p); }
    if (!list.length) { return ''; }
    const names = [...st.groups.keys()].sort();
    setTimeout(() => {
      for (const b of document.querySelectorAll('#groups-' + src + ' button[data-g]')) { b.onclick = () => { st.group = b.dataset.g; for (const x of document.querySelectorAll('#groups-' + src + ' button[data-g]')) x.classList.toggle('sel', x.dataset.g === st.group); showInstances(src, st.groups.get(st.group)); }; }
      if (st.group && st.groups.has(st.group)) {
        showInstances(src, st.groups.get(st.group));
        if (st.instance && st.groups.get(st.group).some(p => p.name === st.instance)) { loadInstance(src, st.instance); }
      }
    }, 0);
    return '<div id="groups-' + src + '">' + names.map(g => '<button class="chip' + (g === st.group ? ' sel' : '') + '" data-g="' + esc(g) + '">' + esc(g) + ' <span class="muted">' + st.groups.get(g).length + '</span></button>').join('') + '</div><div id="instances-' + src + '" class="instances"></div><div id="periph-' + src + '"></div>';
  }
  const state = vscode.getState() || {};
  const save = (patch) => vscode.setState({ ...(vscode.getState() || {}), ...patch });
  function showTab(name) {
    for (const t of ['Target', 'Store', 'Tools']) { $('tab' + t).classList.toggle('active', t === name); $(t.toLowerCase()).classList.toggle('active', t === name); }
    save({ tab: name });
  }
  $('tabTarget').onclick = () => showTab('Target'); $('tabStore').onclick = () => showTab('Store'); $('tabTools').onclick = () => showTab('Tools');

  // ---------------------------------------------------------------- target
  function currentArgs() {
    const v = $('ctxSel').value;
    if (v === '__args') { return { pack: $('ctxPack').value, device: $('ctxDevice').value }; }
    return v ? { target: v } : {};
  }
  function renderContexts(msg) {
    contexts = msg.contexts;
    let h = '';
    for (const c of contexts) { h += '<option value="' + esc(c.name) + '">' + esc(c.name) + ' — ' + esc(c.targetType || '?') + ': ' + esc(c.device || '?') + (c.devicePack ? ' / ' + esc(c.devicePack) : '') + '</option>'; }
    h += '<option value="__args">pack + device…</option>';
    if (!contexts.length) { h = '<option value="">(no *.cbuild-run.yml in the workspace — build first)</option>' + h; }
    $('ctxSel').innerHTML = h;
    if (state.ctx !== undefined && [...$('ctxSel').options].some(o => o.value === state.ctx)) { $('ctxSel').value = state.ctx; }
    if (state.pack) $('ctxPack').value = state.pack; if (state.device) $('ctxDevice').value = state.device;
    $('ctxArgs').style.display = $('ctxSel').value === '__args' ? '' : 'none';
    inspect();
  }
  $('ctxSel').onchange = () => { $('ctxArgs').style.display = $('ctxSel').value === '__args' ? '' : 'none'; save({ ctx: $('ctxSel').value }); };
  $('ctxRefresh').onclick = () => vscode.postMessage({ type: 'target.contexts' });
  function inspect() { save({ ctx: $('ctxSel').value, pack: $('ctxPack').value, device: $('ctxDevice').value }); $('inspectInfo').textContent = 'inspecting…'; vscode.postMessage({ type: 'target.inspect', args: currentArgs() }); }
  $('inspectBtn').onclick = inspect;
  $('ctxDevice').onkeydown = $('ctxPack').onkeydown = (ev) => { if (ev.key === 'Enter') inspect(); };
  function runTool(tool, args) { showTab('Tools'); $('toolSel').value = tool; $('args').value = JSON.stringify(args, null, 2); $('runBtn').onclick(); }
  function browseStore(id) { showTab('Store'); selected = id; if (storeMsg) renderList(storeMsg); vscode.postMessage({ type: 'store.detail', id }); $('detail').innerHTML = '<div class="muted">loading ' + esc(id) + '…</div>'; }
  function renderTarget(r) {
    inspection = r; targetIds = new Set((r.docs || []).map(d => d.id));
    $('inspectInfo').textContent = r.ms + ' ms';
    if (r.error) { $('targetBody').innerHTML = '<pre class="mono">' + esc(r.error) + '</pre>'; return; }
    let h = '<div class="mono">' + esc(r.resolution) + '</div>';
    h += '<div>Core: <b>' + esc(r.processors || 'unknown — no <processor Dcore> in the pdsc') + '</b> <span class="muted">— decides the Arm documents offered</span></div>';
    // SVD and core peripherals: the same chips → instance → bit view, twice.
    h += '<h3>SVD</h3>';
    if (!r.svd) { h += '<div class="muted">the pdsc names no &lt;debug svd&gt; for this device — get_peripheral_docs is unavailable</div>'; }
    else {
      h += '<div><span class="mono">' + esc(r.svd.rel) + '</span>' + (r.svd.pname ? ' <span class="badge">' + esc(r.svd.pname) + '</span>' : '') + (r.svd.exists ? ' <span class="ok">on disk</span> · device ' + esc(r.svd.device || '?') + ' · ' + r.svd.peripherals.length + ' peripherals · <a data-open="' + esc(r.svd.path) + '">open file</a> · <span class="muted">pick a group, then an instance: its registers open as a bit view</span>' : ' <span class="warn">not on disk</span>') + (r.svd.error ? ' <span class="warn">' + esc(r.svd.error) + '</span>' : '') + '</div>';
      h += peripheralSection('svd', r.svd.peripherals);
    }
    h += '<h3>Core peripherals (Arm IP)</h3>';
    if (!r.core) { h += '<div class="warn">no core peripherals: ' + esc(r.coreDiag || 'unknown core') + '</div>'; }
    else {
      h += '<div><span class="mono">' + esc(r.core.rel) + '</span> · ' + esc(r.core.pack || '') + (r.core.exists ? ' <span class="ok">on disk</span> · ' + esc(r.core.coreName || '') + ' · ' + r.core.peripherals.length + ' core peripherals · <a data-open="' + esc(r.core.path) + '">open file</a> · <span class="muted">SCB, NVIC, SysTick, MPU, SAU, FPU, DWT, ITM, TPIU, DCB … from the shipped core SVD (with descriptions) or, failing that, the CMSIS-Core header</span>' : ' <span class="warn">not on disk</span>') + (r.core.error ? ' <span class="warn">' + esc(r.core.error) + '</span>' : '') + '</div>';
      h += peripheralSection('core', r.core.peripherals);
    }
    if (r.npu) {
      h += '<h3>NPU (Ethos-U)</h3>';
      h += '<div><span class="mono">' + esc(r.npu.rel) + '</span> · ' + esc(r.npu.pack || '') + (r.npu.exists ? ' <span class="ok">on disk</span> · ' + esc(r.npu.coreName || '') + ' · <a data-open="' + esc(r.npu.path) + '">open file</a> · <span class="muted">the register map the driver programs; the base address comes from the vendor SVD when it has an NPU peripheral</span>' : ' <span class="warn">not on disk — install the ARM::ethos-u-core-driver pack</span>') + (r.npu.error ? ' <span class="warn">' + esc(r.npu.error) + '</span>' : '') + '</div>';
      h += peripheralSection('npu', r.npu.peripherals);
    }
    // documents
    const docs = r.docs || [];
    const counts = { pack: 0, web: 0, arm: 0, user: 0, workspace: 0 };
    for (const d of docs) { if (d.scope === 'arm') counts.arm++; else if (d.source === 'user') counts.user++; else if (d.source === 'workspace') counts.workspace++; else if (d.source === 'web') counts.web++; else counts.pack++; }
    h += '<h3>Documents (' + docs.length + ': ' + counts.pack + ' pack, ' + counts.web + ' web, ' + counts.arm + ' Arm catalogue, ' + counts.user + ' user, ' + counts.workspace + ' workspace' + (r.workspaceDirs && r.workspaceDirs.length ? ' in ' + esc(r.workspaceDirs.join(', ')) : '') + ')</h3>';
    h += '<div class="muted">User documents folder: <a data-open="' + esc(r.userDir || '') + '" class="mono">' + esc(r.userDir || '') + '</a>' + (r.userMatched && r.userMatched.length ? ' — matched ' + esc(r.userMatched.join(', ')) : ' — no folder matches this target yet') + ' · <a id="importDoc">Import document…</a> (a PDF the pack does not ship, e.g. under NDA; attributed to this pack, device, board or core, indexed at once)</div>';
    h += '<div class="toolbar"><input id="docFilter" placeholder="filter id / title" value="' + esc(docFilter) + '"> <select id="docSource"><option value="">all</option><option value="pack">pack</option><option value="web">web (vendor)</option><option value="arm">Arm catalogue</option><option value="user">user</option><option value="workspace">workspace</option><option value="readable">searchable now</option><option value="unfetched">not fetched</option></select> <a id="runList">run list_target_docs</a></div>';
    h += '<div id="docTable"></div><div id="targetDetail"></div>';
    $('targetBody').innerHTML = h;
    for (const a of document.querySelectorAll('#targetBody a[data-open]')) { a.onclick = () => vscode.postMessage({ type: 'store.open', path: a.dataset.open }); }
    $('docFilter').oninput = () => { docFilter = $('docFilter').value; renderDocTable(); };
    $('docSource').value = docSource; $('docSource').onchange = () => { docSource = $('docSource').value; renderDocTable(); };
    $('runList').onclick = () => runTool('list_target_docs', { ...currentArgs() });
    $('importDoc').onclick = () => vscode.postMessage({ type: 'command', command: 'cmsis-developer-assistant.importUserDoc' });
    renderDocTable();
  }
  function renderDocTable() {
    const docs = (inspection && inspection.docs) || [];
    const f = docFilter.toLowerCase();
    const rows = docs.filter(d => {
      if (f && !(d.id.toLowerCase().includes(f) || (d.title || '').toLowerCase().includes(f))) return false;
      if (docSource === 'pack') return d.source === 'pack';
      if (docSource === 'web') return d.source === 'web' && d.scope !== 'arm';
      if (docSource === 'arm') return d.scope === 'arm';
      if (docSource === 'user') return d.source === 'user';
      if (docSource === 'workspace') return d.source === 'workspace';
      if (docSource === 'readable') return d.readable;
      if (docSource === 'unfetched') return d.source === 'web' && !d.cached;
      return true;
    });
    let h = '<table><tr><th>id</th><th>scope</th><th>title</th><th>state</th><th></th></tr>';
    for (const d of rows) {
      const acts = [];
      if (d.source === 'web' && !d.cached) acts.push('<a data-act="fetch" data-id="' + esc(d.id) + '">fetch</a>');
      if (d.readable && d.indexed) acts.push('<a data-act="browse" data-id="' + esc(d.id) + '">browse</a>');
      if (d.readable && !d.indexed) acts.push('<a data-act="index" data-id="' + esc(d.id) + '">index</a>');
      if (d.readable) acts.push('<a data-act="search" data-id="' + esc(d.id) + '">search</a>');
      if (d.url) acts.push('<a data-open="' + esc(d.url) + '">url</a>'); else if (d.path) acts.push('<a data-open="' + esc(d.path) + '">file</a>');
      const stateCls = d.indexed ? 'ok' : (d.missing || d.unsupported ? 'warn' : '');
      const primary = d.readable && d.indexed ? 'show' : d.readable ? 'index' : (d.source === 'web' && !d.cached ? 'fetch' : '');
      h += '<tr class="' + (primary ? 'row' : '') + (d.id === selected ? ' sel' : '') + '" data-id="' + esc(d.id) + '" data-primary="' + primary + '" title="' + (primary === 'show' ? 'click: show the extracted content' : primary === 'index' ? 'click: extract and index (reads page 1)' : primary === 'fetch' ? 'click: fetch_doc' : '') + '"><td class="mono">' + esc(d.id) + (d.revision ? ' <span class="badge">' + esc(d.revision) + '</span>' : '') + '</td><td>' + esc(d.scope) + (d.kind ? ' · ' + esc(d.kind) : '') + (d.category ? ' [' + esc(d.category) + ']' : '') + '</td><td>' + esc(d.title) + '</td><td class="' + stateCls + '">' + esc(d.state) + '</td><td class="act">' + acts.join('') + '</td></tr>';
    }
    h += '</table>' + (rows.length !== docs.length ? '<div class="muted">' + rows.length + ' of ' + docs.length + ' shown</div>' : '') + '<div class="muted">Click a row: extracted documents show their content below; local documents not yet extracted are indexed; web documents are fetched.</div>';
    $('docTable').innerHTML = h;
    for (const row of document.querySelectorAll('#docTable tr.row')) {
      row.onclick = (ev) => {
        if (ev.target.tagName === 'A') return;
        const id = row.dataset.id, t = currentArgs();
        if (row.dataset.primary === 'show') { selected = id; $('targetDetail').innerHTML = '<div class="muted">loading ' + esc(id) + '…</div>'; vscode.postMessage({ type: 'store.detail', id, into: 'targetDetail' }); renderDocTable(); }
        else if (row.dataset.primary === 'index') runTool('read_doc_pages', { doc: id, pages: '1', ...t });
        else if (row.dataset.primary === 'fetch') runTool('fetch_doc', { doc: id, ...t });
      };
    }
    for (const a of document.querySelectorAll('#docTable a[data-open]')) { a.onclick = () => vscode.postMessage({ type: 'store.open', path: a.dataset.open }); }
    for (const a of document.querySelectorAll('#docTable a[data-act]')) {
      a.onclick = () => {
        const id = a.dataset.id, t = currentArgs();
        if (a.dataset.act === 'fetch') runTool('fetch_doc', { doc: id, ...t });
        else if (a.dataset.act === 'browse') browseStore(id);
        else if (a.dataset.act === 'index') runTool('read_doc_pages', { doc: id, pages: '1', ...t });
        else if (a.dataset.act === 'search') runTool('search_target_docs', { query: '', doc: id, ...t });
      };
    }
  }
  function showInstances(src, list) {
    const st = sel[src];
    $('instances-' + src).innerHTML = '<div class="toolbar">' + list.map(p => '<button class="chip' + (p.name === st.instance ? ' sel' : '') + '" data-p="' + esc(p.name) + '" title="' + hex(p.baseAddress) + (p.derivedFrom ? ' derived from ' + esc(p.derivedFrom) : '') + '">' + esc(p.name) + ' <span class="muted">' + p.registers + 'r' + (src === 'svd' ? ' ' + p.interrupts + 'i' : '') + '</span></button>').join('') + '</div>';
    for (const b of document.querySelectorAll('#instances-' + src + ' button[data-p]')) { b.onclick = () => loadInstance(src, b.dataset.p); }
  }
  function loadInstance(src, name) {
    const st = sel[src];
    st.instance = name;
    for (const x of document.querySelectorAll('#instances-' + src + ' button[data-p]')) x.classList.toggle('sel', x.dataset.p === st.instance);
    const box = $('periph-' + src);
    if (box) { box.innerHTML = '<div class="periph muted">loading ' + esc(name) + '…</div>'; }
    $('status').textContent = '';
    vscode.postMessage({ type: 'target.peripheral', src, name, args: currentArgs() });
  }
  function bitView(reg) {
    const fields = [...reg.fields].sort((a, b) => a.bitOffset - b.bitOffset);
    const top = Math.max(32, ...fields.map(f => f.bitOffset + f.bitWidth));
    const width = top > 32 ? 64 : 32;
    let num = '<tr class="num">', cells = '<tr>';
    for (let b = width - 1; b >= 0; b--) { num += '<td>' + b + '</td>'; }
    let b = width - 1, i = 0;
    while (b >= 0) {
      const f = fields.find(x => b >= x.bitOffset && b < x.bitOffset + x.bitWidth);
      if (f) {
        const span = b - f.bitOffset + 1;
        cells += '<td colspan="' + span + '" class="f' + (i++ % 3) + '" title="' + esc(f.name) + ' [' + (f.bitOffset + f.bitWidth - 1) + ':' + f.bitOffset + ']' + (f.description ? ' — ' + esc(f.description) : '') + '">' + esc(f.name) + '</td>';
        b = f.bitOffset - 1;
      } else {
        let run = 1;
        while (b - run >= 0 && !fields.some(x => (b - run) >= x.bitOffset && (b - run) < x.bitOffset + x.bitWidth)) { run++; }
        cells += '<td colspan="' + run + '" class="u">' + (run >= 3 ? '—' : '') + '</td>';
        b -= run;
      }
    }
    return '<table class="bits">' + num + '</tr>' + cells + '</tr></table>';
  }
  function renderPeripheral(r) {
    const src = r.src === 'core' ? 'core' : r.src === 'npu' ? 'npu' : 'svd';
    const st = sel[src];
    const box = $('periph-' + src);
    if (!box) { return; }
    if (r.name && st.instance && r.name !== st.instance) { return; } // a stale answer for an instance no longer selected
    if (r.error) { box.innerHTML = '<div class="periph warn">' + esc(r.name || '') + ': ' + esc(r.error) + '</div>'; return; }
    const p = r.peripheral;
    let h = '<div class="periph">';
    h += '<div class="toolbar"><b class="mono" style="font-size:115%">' + esc(p.name) + '</b> ' + esc(p.description || '') + ' · base ' + hex(p.baseAddress) + (r.group ? ' · group ' + esc(r.group) : '') + (p.derivedFrom ? ' · derived from ' + esc(p.derivedFrom) : '') + ' · ' + r.registers.length + ' registers <button class="btn" id="dossierBtn">get_peripheral_docs ▶</button></div>';
    if (p.interrupts.length) { h += '<div>Interrupts: ' + p.interrupts.map(i => '<span class="mono">' + esc(i.name) + ' = ' + i.value + '</span>' + (i.description ? ' <span class="muted">' + esc(i.description) + '</span>' : '')).join(', ') + '</div>'; }
    for (const reg of r.registers) {
      h += '<h4 class="mono">' + esc(reg.name) + ' <span class="muted">@0x' + reg.offset.toString(16).toUpperCase().padStart(2, '0') + '</span>' + (reg.description ? ' <span class="muted" style="font-weight:normal">' + esc(reg.description) + '</span>' : '') + '</h4>';
      if (reg.fields.length) {
        h += bitView(reg);
        h += '<table class="fields">' + [...reg.fields].sort((a, b) => b.bitOffset - a.bitOffset).map(f => '<tr><td class="mono">' + esc(f.name) + '</td><td class="mono muted">[' + (f.bitOffset + f.bitWidth - 1) + ':' + f.bitOffset + ']</td><td>' + esc(f.description || '') + '</td></tr>').join('') + '</table>';
      } else {
        h += '<div class="muted">no fields in the SVD</div>';
      }
    }
    h += '</div>';
    box.innerHTML = h;
    box.querySelector('#dossierBtn').onclick = () => runTool('get_peripheral_docs', { peripheral: p.name, ...currentArgs() });
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ----------------------------------------------------------------- store
  function renderList(msg) {
    storeMsg = msg; entries = msg.entries;
    const only = !!(vscode.getState() || {}).onlyTarget && targetIds.size;
    const shown = only ? entries.filter(e => targetIds.has(e.id)) : entries;
    let h = '<div class="muted" style="padding:6px 8px">' + esc(msg.storageDir) + ' · ' + entries.length + ' extracted' + (msg.fetchedOnly.length ? ', ' + msg.fetchedOnly.length + ' fetch records without extraction' : '') + ' <a id="refresh">refresh</a><br><label><input type="checkbox" id="onlyTarget"' + (only ? ' checked' : '') + '> only the Target tab\\'s documents (' + targetIds.size + ')</label></div>';
    h += '<table><tr><th>id</th><th>src</th><th>pages</th><th>size</th><th>extracted</th></tr>';
    for (const e of shown) {
      h += '<tr class="row' + (e.id === selected ? ' sel' : '') + '" data-id="' + esc(e.id) + '"><td class="mono">' + esc(e.id) + (e.revision ? ' <span class="badge">' + esc(e.revision) + '</span>' : '') + (e.fileExists ? '' : ' <span class="badge">source missing</span>') + '</td><td>' + esc(e.source) + '</td><td>' + e.pageCount + (e.unit === 'section' ? ' §' : '') + '</td><td>' + kb(e.sizeBytes) + '</td><td class="muted">' + esc((e.createdAt || '').slice(0, 16).replace('T', ' ')) + '</td></tr>';
    }
    for (const f of msg.fetchedOnly) {
      if (only && !targetIds.has(f.id)) continue;
      h += '<tr><td class="mono">' + esc(f.id) + ' <span class="badge">' + esc(f.format || 'not extracted') + '</span></td><td>web</td><td>–</td><td></td><td class="muted">' + esc(f.title || '') + '</td></tr>';
    }
    h += '</table>';
    if (!shown.length) { h += '<div class="muted" style="padding:8px">Nothing extracted yet' + (only ? ' for this target' : '') + '. The Target tab\\'s index / fetch actions, or any search, fill the store.</div>'; }
    $('list').innerHTML = h;
    $('refresh').onclick = () => vscode.postMessage({ type: 'store.list' });
    $('onlyTarget').onchange = () => { save({ onlyTarget: $('onlyTarget').checked }); renderList(storeMsg); };
    for (const row of document.querySelectorAll('tr.row')) { row.onclick = () => { selected = row.dataset.id; $('detail').innerHTML = '<div class="muted">loading ' + esc(selected) + '…</div>'; vscode.postMessage({ type: 'store.detail', id: selected }); renderList(storeMsg); }; }
  }
  function renderDetail(d) {
    const into = d.into || 'detail';
    const e = entries.find(x => x.id === d.id) || {};
    let h = '<h2 class="mono">' + esc(d.id) + '</h2>';
    h += '<div class="muted">' + esc(e.title || '') + ' · ' + esc(e.source) + ' · ' + d.index.pages + ' ' + (e.unit === 'section' ? 'sections' : 'pages') + ' · extracted with ' + esc(e.extractor) + ' · read in ' + d.ms + ' ms</div>';
    h += '<div class="toolbar"><a data-open="' + esc(e.file) + '">source file</a> <a data-open="' + esc(e.metaPath) + '">meta.json</a> <a data-open="' + esc(e.pagesPath) + '">pages.jsonl</a> <a data-open="' + esc(e.indexPath) + '">idx.json</a> <a data-open="' + esc(e.dir) + '">folder</a> <span class="muted">sidecars ' + kb(e.storedBytes) + '</span> <a id="searchThis">search this document</a></div>';
    h += '<h3>Page</h3><div class="toolbar"><input id="pageNo" type="number" min="1" max="' + d.index.pages + '" value="1" style="width:6em"> of ' + d.index.pages + ' <button class="btn" id="pageBtn">Show</button> <span class="muted" id="pageHead"></span></div><pre id="pageText" class="mono muted">—</pre>';
    h += '<h3>Chapters (' + d.chapters.length + ', ' + d.pagesWithHeading + ' pages with a heading)</h3>';
    if (d.chapters.length) {
      h += '<table><tr><th>#</th><th>title</th><th>acronyms</th><th>pages</th><th>sections</th></tr>';
      for (const c of d.chapters) { h += '<tr><td>' + c.number + '</td><td>' + esc(c.title) + '</td><td class="mono">' + esc(c.acronyms.join(' ')) + '</td><td><a data-page="' + c.start + '">' + c.start + '</a>–' + c.end + '</td><td>' + c.sections + '</td></tr>'; }
      h += '</table>';
    }
    h += '<h3>Index</h3><div>' + d.index.tokens + ' distinct tokens · average ' + d.index.avgLength + ' tokens per page</div>';
    h += '<div class="mono muted" style="margin:4px 0">' + d.index.top.map(t => esc(t.token) + '<span class="muted">(' + t.pages + ')</span>').join(' ') + '</div>';
    if (d.fetch) { h += '<h3>Fetch record</h3><pre class="mono">' + esc(JSON.stringify(d.fetch, null, 2)) + '</pre>'; }
    h += '<h3>Metadata</h3><pre class="mono">' + esc(JSON.stringify(d.meta, null, 2)) + '</pre>';
    const box = $(into); box.innerHTML = h;
    for (const a of box.querySelectorAll('a[data-open]')) { a.onclick = () => vscode.postMessage({ type: 'store.open', path: a.dataset.open }); }
    const pageNo = box.querySelector('#pageNo'), pageBtn = box.querySelector('#pageBtn');
    const show = () => vscode.postMessage({ type: 'store.page', id: d.id, page: Number(pageNo.value), into });
    pageBtn.onclick = show; pageNo.onkeydown = (ev) => { if (ev.key === 'Enter') show(); };
    for (const a of box.querySelectorAll('a[data-page]')) { a.onclick = () => { pageNo.value = a.dataset.page; show(); }; }
    box.querySelector('#searchThis').onclick = () => runTool('search_target_docs', { query: '', doc: d.id, ...currentArgs() });
  }

  // ----------------------------------------------------------------- tools
  function renderTools(msg) {
    templates = {}; let h = '';
    for (const t of msg.tools) { templates[t.name] = t.template; h += '<option value="' + esc(t.name) + '">' + esc(t.name) + '</option>'; }
    $('toolSel').innerHTML = h;
    if (state.tool && templates[state.tool]) { $('toolSel').value = state.tool; }
    $('args').value = state.args || JSON.stringify(templates[$('toolSel').value] || {}, null, 2);
  }
  $('toolSel').onchange = () => { $('args').value = JSON.stringify(templates[$('toolSel').value] || {}, null, 2); save({ tool: $('toolSel').value, args: $('args').value }); };
  $('resetBtn').onclick = () => { $('args').value = JSON.stringify(templates[$('toolSel').value] || {}, null, 2); };
  $('runBtn').onclick = () => {
    let args = $('args').value;
    if ($('addTarget').checked) { try { const o = JSON.parse(args || '{}'); const t = currentArgs(); for (const k of Object.keys(t)) { if (t[k] && o[k] === undefined) o[k] = t[k]; } args = JSON.stringify(o, null, 2); $('args').value = args; } catch (e) { /* the handler reports the JSON error */ } }
    $('runInfo').textContent = 'running…'; $('runBtn').disabled = true; save({ tool: $('toolSel').value, args: $('args').value });
    vscode.postMessage({ type: 'tool.run', tool: $('toolSel').value, args });
  };
  $('args').onkeydown = (ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') $('runBtn').onclick(); };

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    try { handle(m); } catch (e) { $('status').textContent = 'panel error: ' + (e && e.message ? e.message : e); console.error(e); }
  });
  function handle(m) {
    if (m.type === 'target.contexts') renderContexts(m);
    else if (m.type === 'target.inspect') { renderTarget(m); if (storeMsg) renderList(storeMsg); }
    else if (m.type === 'target.peripheral') renderPeripheral(m);
    else if (m.type === 'store.list') renderList(m);
    else if (m.type === 'store.detail') renderDetail(m);
    else if (m.type === 'store.page') { const box = $(m.into || 'detail'); const head = box.querySelector('#pageHead'), txt = box.querySelector('#pageText'); if (head) head.textContent = 'p.' + m.page + (m.heading ? ' §' + m.heading : ''); if (txt) { txt.textContent = m.text || '(empty page)'; txt.classList.remove('muted'); } }
    else if (m.type === 'tools.list') renderTools(m);
    else if (m.type === 'tool.result') {
      $('runBtn').disabled = false; $('runInfo').textContent = m.ms + ' ms · ' + m.text.length + ' chars';
      $('out').textContent = m.text;
      history.unshift(m); history = history.slice(0, 20);
      $('hist').innerHTML = '<div class="muted">History (click to restore)</div>' + history.map((x, i) => '<div><a data-h="' + i + '" class="mono">' + esc(x.tool) + ' ' + esc(x.args) + '</a> <span class="muted">' + x.ms + ' ms</span></div>').join('');
      for (const a of document.querySelectorAll('a[data-h]')) { a.onclick = () => { const x = history[Number(a.dataset.h)]; $('toolSel').value = x.tool; $('args').value = JSON.stringify(JSON.parse(x.args || '{}'), null, 2); $('out').textContent = x.text; }; }
      if (/^(Fetched|Already fetched)|Indexed now|^— /.test(m.text)) { vscode.postMessage({ type: 'store.list' }); if (inspection) vscode.postMessage({ type: 'target.inspect', args: currentArgs() }); }
    }
    else if (m.type === 'refresh') { vscode.postMessage({ type: 'store.list' }); if (inspection) vscode.postMessage({ type: 'target.inspect', args: currentArgs() }); }
    else if (m.type === 'error') { $('status').textContent = m.text; $('runBtn').disabled = false; $('runInfo').textContent = 'failed'; $('out').textContent = m.text; $('inspectInfo').textContent = 'failed'; for (const id of ['detail', 'targetDetail']) { const b = $(id); if (b && /loading/.test(b.textContent)) b.innerHTML = '<pre class="mono warn">' + esc(m.text) + '</pre>'; } }
  }
  showTab(state.tab || 'Target');
  vscode.postMessage({ type: 'target.contexts' });
  vscode.postMessage({ type: 'store.list' });
  vscode.postMessage({ type: 'tools.list' });
</script>
</body>
</html>`;
    }
}
