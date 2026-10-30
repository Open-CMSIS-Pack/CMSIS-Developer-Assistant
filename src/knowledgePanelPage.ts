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
 * The stylesheet and the script of the knowledge browser's page
 * (`knowledgePanel.ts`), as two strings. The script is plain browser
 * JavaScript: it keeps the list, the filters and the selection, draws the
 * relations of a node as an SVG graph, and asks the extension for data with
 * messages. It builds every element with `textContent` and attributes; the
 * only HTML it inserts is the rendered text of a unit, which
 * `core/knowledge/browse.ts` builds from escaped text.
 *
 * Both strings are raw: no interpolation, so neither holds a backtick.
 */

export const KNOWLEDGE_PANEL_STYLE = String.raw`
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column;
    --c-procedure: var(--vscode-charts-blue, #3794ff); --c-concept: var(--vscode-charts-purple, #b180d7); --c-pattern: var(--vscode-charts-green, #89d185);
    --c-rule: var(--vscode-charts-red, #f14c4c); --c-troubleshooting: var(--vscode-charts-orange, #d18616); --c-asset: var(--vscode-charts-yellow, #cca700);
    --c-entity: var(--vscode-descriptionForeground, #8a8a8a); --line: var(--vscode-panel-border, rgba(127,127,127,.35)); }
  [hidden] { display: none !important; }
  .muted { opacity: .7; } .grow { flex: 1; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; } a:hover { text-decoration: underline; }
  code, pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  h2 { margin: 0; font-size: 1.35em; font-weight: 600; } h3 { margin: 18px 0 6px; font-size: 1.05em; }
  input[type=search], select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font: inherit; border-radius: 2px; }
  input[type=search]:focus, select:focus, #list:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; font: inherit; border-radius: 2px; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.ghost { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--line); }
  .btn.ghost:hover { background: var(--vscode-list-hoverBackground); } .btn:disabled { opacity: .35; cursor: default; }
  .check { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer; }
  .badge { display: inline-block; padding: 0 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 85%; font-weight: normal; }
  .badge:empty { display: none; }

  .header { flex: none; border-bottom: 1px solid var(--line); background: var(--vscode-editor-background); }
  .bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px 2px; }
  .brand { font-weight: 600; font-size: 1.1em; }
  .tabs, .subtabs { display: flex; gap: 2px; padding: 0 10px; }
  .tabs button, .subtabs button { background: none; border: none; color: var(--vscode-foreground); padding: 6px 10px; cursor: pointer; border-bottom: 2px solid transparent; font: inherit; opacity: .75; }
  .tabs button:hover, .subtabs button:hover { opacity: 1; }
  .tabs button.active, .subtabs button.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; opacity: 1; }
  .subtabs { padding: 0; border-bottom: 1px solid var(--line); margin-top: 10px; }

  .view { display: none; flex: 1; min-height: 0; }
  .view.active { display: block; overflow: auto; padding: 10px 16px 24px; }
  #units.active { display: grid; grid-template-columns: minmax(300px, 36%) 1fr; grid-template-rows: minmax(0, 1fr); padding: 0; overflow: hidden; }
  .empty.active, .view.empty:not([hidden]) { display: flex; align-items: center; justify-content: center; }
  .emptybox { max-width: 520px; margin: 48px auto; text-align: center; }

  #side { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
  .search { padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 3px; }
  .search input { width: 100%; box-sizing: border-box; }
  #searchNote { font-size: 90%; min-height: 1.2em; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 2px 12px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); background: transparent; color: var(--vscode-foreground); border-radius: 11px; padding: 1px 9px; cursor: pointer; font: inherit; font-size: 92%; }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  .chip.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: transparent; }
  .chip .n { opacity: .7; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c); flex: none; display: inline-block; }
  .t-procedure { --c: var(--c-procedure); } .t-concept { --c: var(--c-concept); } .t-pattern { --c: var(--c-pattern); } .t-rule { --c: var(--c-rule); }
  .t-troubleshooting { --c: var(--c-troubleshooting); } .t-asset { --c: var(--c-asset); } .t-entity { --c: var(--c-entity); }
  .filters { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--line); }
  .filters { flex-wrap: wrap; row-gap: 4px; }
  .filters select { max-width: 46%; }
  #list { flex: 1; overflow: auto; min-height: 0; }
  .row { padding: 6px 12px 7px; border-bottom: 1px solid var(--line); cursor: pointer; border-left: 3px solid transparent; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.sel { background: var(--vscode-list-inactiveSelectionBackground); border-left-color: var(--c); }
  .row .t { display: flex; align-items: baseline; gap: 6px; }
  .row .t .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .s { opacity: .78; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 2px 0 0 15px; font-size: 94%; }
  .row .m { margin: 2px 0 0 15px; font-size: 86%; opacity: .7; display: flex; gap: 8px; flex-wrap: wrap; }
  .row.dim .name, .row.dim .s { opacity: .55; }
  .tag { border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; font-size: 86%; white-space: nowrap; }
  .tag.warn { color: var(--vscode-editorWarning-foreground, #cca700); border-color: currentColor; }
  .tag.ok { color: var(--vscode-testing-iconPassed, #73c991); border-color: currentColor; }
  .tag.hit { color: var(--vscode-textLink-foreground); border-color: currentColor; }
  .more { padding: 10px 12px; opacity: .7; }

  #main { overflow: auto; min-height: 0; padding: 12px 20px 28px; }
  .dhead { display: flex; gap: 10px; align-items: flex-start; }
  .nav { display: flex; gap: 4px; flex: none; padding-top: 2px; } .nav .btn { padding: 2px 8px; }
  .dtitle { min-width: 0; flex: 1; }
  .line1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .line2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; font-size: 92%; }
  .pill { background: var(--c); color: #fff; border-radius: 10px; padding: 1px 9px; font-size: 85%; text-transform: lowercase; white-space: nowrap; }
  .pill.t-asset, .pill.t-pattern { color: #1e1e1e; }
  .summary { margin: 10px 0 4px; font-size: 1.05em; line-height: 1.45; max-width: 90ch; }
  #dFiles { padding: 4px 0 0; }
  .sub { display: none; padding-top: 10px; } .sub.active { display: block; }

  .md { line-height: 1.55; max-width: 100ch; }
  .md h2 { font-size: 1.3em; margin: 20px 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--line); } .md h3 { font-size: 1.12em; margin: 16px 0 4px; }
  .md h4, .md h5, .md h6 { font-size: 1em; margin: 12px 0 4px; }
  .md p { margin: 6px 0; }
  .md pre, pre.file { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 3px; overflow: auto; white-space: pre; line-height: 1.4; }
  .md code { background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; } .md pre code { background: none; padding: 0; }
  .md .li { display: flex; gap: 8px; margin: 3px 0; } .md .li .mark { flex: none; min-width: 1.4em; text-align: right; opacity: .75; }
  .md .d1 { margin-left: 22px; } .md .d2 { margin-left: 44px; } .md .d3 { margin-left: 66px; } .md .d4, .md .d5, .md .d6 { margin-left: 88px; }
  .md blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid var(--vscode-textBlockQuote-border, var(--line)); background: var(--vscode-textBlockQuote-background); }
  .md hr { border: none; border-top: 1px solid var(--line); margin: 14px 0; }
  .md a.ref code { color: var(--vscode-textLink-foreground); } .md a.ext::after { content: " ↗"; font-size: 85%; }
  table { border-collapse: collapse; }
  table.md, #relTable, table.kv { width: 100%; margin: 8px 0; }
  table.md th, table.md td, #relTable td, #relTable th, table.kv td { text-align: left; padding: 3px 8px; vertical-align: top; border-bottom: 1px solid var(--line); }
  table.md th, #relTable th { font-weight: 600; background: var(--vscode-editorWidget-background, transparent); }
  table.kv td:first-child { white-space: nowrap; opacity: .75; width: 1%; padding-right: 18px; }
  table.kv td { word-break: break-word; }
  #relTable tr.link { cursor: pointer; } #relTable tr.link:hover { background: var(--vscode-list-hoverBackground); }
  #relTable td.rel { white-space: nowrap; }

  .gbar { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  /* resize: the browser's grip in the bottom-right corner; overflow must not be visible for it to appear. */
  #graphWrap { border: 1px solid var(--line); border-radius: 4px; background: var(--vscode-editorWidget-background, transparent); height: 460px; min-height: 180px; max-height: 85vh; overflow: hidden; resize: vertical; cursor: grab; }
  #graphWrap.drag { cursor: grabbing; }
  #graph { width: 100%; height: 100%; display: block; user-select: none; }
  #graph .edge { stroke: var(--rc, var(--c-entity)); stroke-width: 1.4; opacity: .6; fill: none; }
  #graph .elabel { font-size: 9px; fill: var(--vscode-foreground); opacity: .6; text-anchor: middle; pointer-events: none; }
  #graph .gn { cursor: pointer; }
  #graph .gn .shape { fill: var(--c); stroke: var(--vscode-editor-background); stroke-width: 2; }
  #graph .gn.centre .shape { stroke: var(--vscode-focusBorder); stroke-width: 3; }
  #graph .gn text { font-size: 11px; fill: var(--vscode-foreground); text-anchor: middle; pointer-events: none; }
  #graph .gn.r2 text { font-size: 9px; opacity: .8; } #graph .gn.centre text { font-weight: 600; font-size: 12px; }
  #graph.hl .gn:not(.on), #graph.hl .edge:not(.on), #graph.hl .elabel:not(.on) { opacity: .15; }
  #graph .edge.on { opacity: 1; stroke-width: 2; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 2px; font-size: 90%; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .legend .ln { width: 18px; height: 0; border-top: 2px solid var(--rc, var(--c-entity)); display: inline-block; }
  .r-requires { --rc: var(--c-procedure); } .r-constrains { --rc: var(--c-rule); } .r-refines { --rc: var(--c-concept); } .r-applies_to { --rc: var(--c-pattern); }
  .r-references { --rc: var(--c-asset); } .r-produces, .r-consumes { --rc: var(--c-troubleshooting); }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 6px 0 4px; }
  .card { border: 1px solid var(--line); border-radius: 5px; padding: 10px 12px; background: var(--vscode-editorWidget-background, transparent); }
  .card .v { font-size: 1.7em; font-weight: 600; line-height: 1.1; } .card .k { opacity: .75; margin-top: 2px; }
  .ovgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 4px 32px; }
  .bars .bar1 { display: grid; grid-template-columns: 150px 1fr 56px; align-items: center; gap: 8px; padding: 2px 0; }
  .bars .bar1.link { cursor: pointer; } .bars .bar1.link:hover .lab { text-decoration: underline; }
  .bars .lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .bars .track { height: 9px; border-radius: 5px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.15)); overflow: hidden; }
  .bars .fill { height: 100%; border-radius: 5px; background: var(--c, var(--vscode-progressBar-background, #0e70c0)); min-width: 2px; }
  .bars .num { text-align: right; font-variant-numeric: tabular-nums; opacity: .85; }
  .routes { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .route { border: 1px solid var(--line); border-left: 4px solid var(--c-concept); border-radius: 4px; padding: 8px 12px; cursor: pointer; }
  .route:hover { background: var(--vscode-list-hoverBackground); } .route b { display: block; margin-bottom: 2px; }
`;

export const KNOWLEDGE_PANEL_SCRIPT = String.raw`
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var TYPES = ['procedure', 'concept', 'pattern', 'rule', 'troubleshooting'];
  var MAX_ROWS = 600;
  var SVG = 'http://www.w3.org/2000/svg';
  var S = { units: [], byId: {}, overview: null, types: {}, domain: '', collection: '', hideIncomplete: false, query: '', hits: null, marks: {},
            sel: null, detail: null, sub: 'text', depth: 1, back: [], fwd: [], seq: 0, view: null, graphFor: null };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = String(text); }
    return e;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function typeClass(node) {
    if (node.kind === 'entity') { return node.type === 'asset' ? 't-asset' : 't-entity'; }
    return TYPES.indexOf(node.type) >= 0 ? 't-' + node.type : 't-entity';
  }
  function short(text, n) { return text.length > n ? text.slice(0, n - 1) + '…' : text; }
  function post(message) { vscode.postMessage(message); }

  // ── tabs ────────────────────────────────────────────────────────────────
  function showTab(tab) {
    var buttons = document.querySelectorAll('.tabs button');
    for (var i = 0; i < buttons.length; i++) { buttons[i].classList.toggle('active', buttons[i].dataset.tab === tab); }
    $('units').classList.toggle('active', tab === 'units');
    $('overview').classList.toggle('active', tab === 'overview');
  }
  function showSub(sub) {
    S.sub = sub;
    var buttons = document.querySelectorAll('.subtabs button');
    for (var i = 0; i < buttons.length; i++) { buttons[i].classList.toggle('active', buttons[i].dataset.sub === sub); }
    ['text', 'graph', 'meta'].forEach(function (name) { $('sub-' + name).classList.toggle('active', name === sub); });
    if (sub === 'graph' && S.sel && S.graphFor !== S.sel + '|' + S.depth) { post({ type: 'graph', id: S.sel, depth: S.depth }); }
  }

  // ── list ────────────────────────────────────────────────────────────────
  function visibleUnits() {
    var typed = Object.keys(S.types).filter(function (t) { return S.types[t]; });
    var pass = function (u) {
      return (typed.length === 0 || S.types[u.type]) && (!S.domain || u.domain === S.domain) && (!S.collection || u.collection === S.collection)
        && (!S.hideIncomplete || !u.incomplete);
    };
    if (S.hits) {
      return S.hits.map(function (id) { return S.byId[id]; }).filter(function (u) { return u && pass(u); });
    }
    return S.units.filter(pass);
  }
  function renderChips() {
    var box = $('typeChips');
    clear(box);
    var counts = {};
    S.units.forEach(function (u) { counts[u.type] = (counts[u.type] || 0) + 1; });
    TYPES.filter(function (t) { return counts[t]; }).forEach(function (t) {
      var chip = el('button', 'chip t-' + t + (S.types[t] ? ' on' : ''));
      chip.appendChild(el('span', 'dot'));
      chip.appendChild(el('span', '', t));
      chip.appendChild(el('span', 'n', counts[t]));
      chip.onclick = function () { S.types[t] = !S.types[t]; renderChips(); renderList(); };
      box.appendChild(chip);
    });
  }
  function rowOf(u) {
    var row = el('div', 'row t-' + u.type + (u.id === S.sel ? ' sel' : '') + (u.incomplete ? ' dim' : ''));
    row.dataset.id = u.id;
    var top = el('div', 't');
    top.appendChild(el('span', 'dot'));
    top.appendChild(el('span', 'name', u.title));
    row.appendChild(top);
    if (u.summary && u.summary !== u.title) { row.appendChild(el('div', 's', u.summary)); }
    var meta = el('div', 'm');
    meta.appendChild(el('span', '', u.id));
    if (u.tool) { meta.appendChild(el('span', 'tag', u.tool + (u.code ? ' ' + u.code : ''))); }
    if (u.domain) { meta.appendChild(el('span', '', u.domain)); }
    if (S.marks[u.id] === 'exact') { meta.appendChild(el('span', 'tag hit', 'exact message')); }
    if (S.marks[u.id] === 'unverified') { meta.appendChild(el('span', 'tag warn', 'applies: unverified')); }
    if (u.status === 'reviewed') { meta.appendChild(el('span', 'tag ok', 'reviewed')); }
    if (u.incomplete) { meta.appendChild(el('span', 'tag warn', 'no text yet')); }
    if (u.files) { meta.appendChild(el('span', '', u.files + (u.files === 1 ? ' file' : ' files'))); }
    row.appendChild(meta);
    return row;
  }
  function renderList() {
    var list = $('list');
    var shown = visibleUnits();
    clear(list);
    var fragment = document.createDocumentFragment();
    shown.slice(0, MAX_ROWS).forEach(function (u) { fragment.appendChild(rowOf(u)); });
    if (shown.length > MAX_ROWS) { fragment.appendChild(el('div', 'more', (shown.length - MAX_ROWS) + ' more: narrow the filter or search.')); }
    if (shown.length === 0) { fragment.appendChild(el('div', 'more', S.hits ? 'Nothing matched. Try the exact error text, or fewer words.' : 'No unit passes the filters.')); }
    list.appendChild(fragment);
    $('listCount').textContent = shown.length + ' of ' + S.units.length;
  }
  function markSelection() {
    var rows = $('list').children;
    for (var i = 0; i < rows.length; i++) {
      var on = rows[i].dataset && rows[i].dataset.id === S.sel;
      rows[i].classList.toggle('sel', !!on);
      if (on && rows[i].scrollIntoView) { rows[i].scrollIntoView({ block: 'nearest' }); }
    }
  }

  // ── navigation ──────────────────────────────────────────────────────────
  function open(id, keepHistory) {
    if (!id) { return; }
    if (!keepHistory && S.sel && S.sel !== id) { S.back.push(S.sel); S.fwd = []; }
    S.sel = id;
    $('back').disabled = S.back.length === 0;
    $('forward').disabled = S.fwd.length === 0;
    showTab('units');
    post({ type: 'unit', id: id });
    if (S.sub === 'graph') { post({ type: 'graph', id: id, depth: S.depth }); }
    markSelection();
  }
  function step(from, to) {
    if (from.length === 0) { return; }
    if (S.sel) { to.push(S.sel); }
    open(from.pop(), true);
  }

  // ── detail ──────────────────────────────────────────────────────────────
  function renderDetail(d) {
    S.detail = d;
    $('detailEmpty').hidden = true;
    $('detail').hidden = false;
    var pill = $('dType');
    pill.className = 'pill ' + typeClass(d);
    pill.textContent = d.type || d.kind;
    $('dTitle').textContent = d.title || d.id;
    $('dId').textContent = d.id;
    var badges = $('dBadges');
    clear(badges);
    if (d.domain) { badges.appendChild(el('span', 'tag', d.domain)); }
    if (d.status) { badges.appendChild(el('span', 'tag ' + (d.status === 'reviewed' ? 'ok' : ''), d.status)); }
    if (d.incomplete) { badges.appendChild(el('span', 'tag warn', 'no cause or text yet')); }
    if (d.tokens) { badges.appendChild(el('span', 'muted', 'about ' + d.tokens + ' tokens')); }
    $('openSource').hidden = !d.sourcePath;
    $('dSummary').textContent = d.summary && d.summary !== d.title ? d.summary : '';
    $('dSummary').hidden = !$('dSummary').textContent;

    var files = $('dFiles');
    clear(files);
    d.files.forEach(function (file) {
      var chip = el('button', 'chip t-asset');
      chip.appendChild(el('span', 'dot'));
      chip.appendChild(el('span', '', file.path));
      chip.title = 'Open the file ' + file.id;
      chip.onclick = function () { open(file.id); };
      files.appendChild(chip);
    });

    var body = $('dBody');
    if (d.html) { body.innerHTML = d.html; } else { clear(body); body.appendChild(el('p', 'muted', d.kind === 'entity' ? 'An entity of the graph: it has relations, no text.' : 'This unit has no text.')); }

    $('relBadge').textContent = d.relationTotal || '';
    var meta = $('metaTable');
    clear(meta);
    var rows = [{ key: 'id', value: d.id }, { key: 'kind', value: d.kind }, { key: 'type', value: d.type }];
    if (d.domain) { rows.push({ key: 'domain', value: d.domain }); }
    rows.concat(d.meta).forEach(function (entry) {
      var tr = el('tr');
      tr.appendChild(el('td', '', entry.key));
      tr.appendChild(el('td', '', entry.value));
      meta.appendChild(tr);
    });
    renderRelations(d);
    $('main').scrollTop = 0;
    if (d.html === '' && d.kind === 'entity' && S.sub === 'text') { showSub('graph'); }
  }
  function renderRelations(d) {
    var table = $('relTable');
    clear(table);
    if (d.relations.length === 0) { return; }
    var head = el('tr');
    ['Relation', 'Node', 'Type', 'Title'].forEach(function (name) { head.appendChild(el('th', '', name)); });
    table.appendChild(head);
    d.relations.forEach(function (r) {
      var tr = el('tr', r.known ? 'link' : '');
      tr.appendChild(el('td', 'rel', r.direction === 'out' ? r.relation + ' →' : '← ' + r.relation));
      var idCell = el('td');
      idCell.appendChild(el('code', '', r.id));
      tr.appendChild(idCell);
      tr.appendChild(el('td', '', r.type || ''));
      tr.appendChild(el('td', '', r.title && r.title !== r.id ? r.title : ''));
      if (r.known) { tr.onclick = function () { open(r.id); }; }
      table.appendChild(tr);
    });
    if (d.relationTotal > d.relations.length) {
      var more = el('tr');
      var cell = el('td', 'muted', (d.relationTotal - d.relations.length) + ' more relations are not listed.');
      cell.colSpan = 4;
      more.appendChild(cell);
      table.appendChild(more);
    }
  }

  // ── graph ───────────────────────────────────────────────────────────────
  function svg(tag, attrs) {
    var e = document.createElementNS(SVG, tag);
    for (var key in attrs) { e.setAttribute(key, attrs[key]); }
    return e;
  }
  function layout(g) {
    var pos = {};
    var ring1 = g.nodes.filter(function (n) { return n.ring === 1; });
    var relOf = {};
    g.edges.forEach(function (e) {
      if (e.from === g.centre) { relOf[e.to] = 'a' + e.relation; } else if (e.to === g.centre) { relOf[e.from] = 'b' + e.relation; }
    });
    ring1.sort(function (a, b) { return (relOf[a.id] || '').localeCompare(relOf[b.id] || '') || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id); });
    var r1 = Math.max(190, ring1.length * 128 / (2 * Math.PI));
    pos[g.centre] = { x: 0, y: 0, a: 0 };
    ring1.forEach(function (n, i) {
      var a = -Math.PI / 2 + 2 * Math.PI * i / Math.max(ring1.length, 1);
      pos[n.id] = { x: r1 * Math.cos(a), y: r1 * Math.sin(a), a: a };
    });
    var children = {};
    g.nodes.filter(function (n) { return n.ring === 2; }).forEach(function (n) { (children[n.parent] = children[n.parent] || []).push(n); });
    var sector = 2 * Math.PI / Math.max(ring1.length, 1);
    var r2 = r1 + 150;
    Object.keys(children).forEach(function (parent) {
      var list = children[parent];
      var base = pos[parent] ? pos[parent].a : 0;
      var gap = Math.min(0.22, sector * 0.92 / list.length);
      list.forEach(function (n, i) {
        var a = base + (i - (list.length - 1) / 2) * gap;
        var r = r2 + (i % 2) * 34;
        pos[n.id] = { x: r * Math.cos(a), y: r * Math.sin(a), a: a };
      });
    });
    return pos;
  }
  function setView(view) {
    S.view = view;
    $('graph').setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
  }
  function fitGraph(pos) {
    var xs = [], ys = [];
    Object.keys(pos).forEach(function (id) { xs.push(pos[id].x); ys.push(pos[id].y); });
    var pad = 90;
    var x0 = Math.min.apply(null, xs) - pad, x1 = Math.max.apply(null, xs) + pad;
    var y0 = Math.min.apply(null, ys) - pad * 0.6, y1 = Math.max.apply(null, ys) + pad * 0.8;
    var box = $('graphWrap').getBoundingClientRect();
    var ratio = box.width > 0 && box.height > 0 ? box.width / box.height : 1.8;
    var w = x1 - x0, h = y1 - y0;
    // A node or two would fill the frame: keep the scale of a small graph.
    if (w < 720) { x0 -= (720 - w) / 2; w = 720; }
    if (w / h < ratio) { var nw = h * ratio; x0 -= (nw - w) / 2; w = nw; } else { var nh = w / ratio; y0 -= (nh - h) / 2; h = nh; }
    setView({ x: x0, y: y0, w: w, h: h });
  }
  function renderGraph(g) {
    S.graphFor = g.centre + '|' + S.depth;
    S.graph = g;
    var root = $('graph');
    clear(root);
    var pos = layout(g);
    S.pos = pos;
    var byId = {};
    g.nodes.forEach(function (n) { byId[n.id] = n; });
    var radius = function (n) { return n.ring === 0 ? 17 : n.ring === 1 ? 11 : 7; };
    var defs = svg('defs', {});
    var marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.appendChild(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }));
    defs.appendChild(marker);
    root.appendChild(defs);
    var edgeLayer = svg('g', {}), nodeLayer = svg('g', {});
    var labelled = g.nodes.length <= 18;
    g.edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) { return; }
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ra = radius(byId[e.from]) + 2, rb = radius(byId[e.to]) + 5;
      var line = svg('line', { x1: a.x + dx / len * ra, y1: a.y + dy / len * ra, x2: b.x - dx / len * rb, y2: b.y - dy / len * rb,
        'class': 'edge r-' + e.relation, 'marker-end': 'url(#arrow)' });
      line.dataset.from = e.from; line.dataset.to = e.to;
      var tip = svg('title', {}); tip.textContent = e.from + '  ' + e.relation + '  ' + e.to; line.appendChild(tip);
      edgeLayer.appendChild(line);
      if (labelled) {
        var label = svg('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 3, 'class': 'elabel' });
        label.textContent = e.relation; label.dataset.from = e.from; label.dataset.to = e.to;
        edgeLayer.appendChild(label);
      }
    });
    g.nodes.forEach(function (n) {
      var p = pos[n.id];
      if (!p) { return; }
      var r = radius(n);
      var group = svg('g', { 'class': 'gn ' + typeClass(n) + (n.ring === 0 ? ' centre' : n.ring === 2 ? ' r2' : ''), transform: 'translate(' + p.x + ',' + p.y + ')' });
      group.dataset.id = n.id;
      group.appendChild(n.kind === 'entity'
        ? svg('rect', { x: -r, y: -r, width: 2 * r, height: 2 * r, rx: 3, 'class': 'shape' })
        : svg('circle', { r: r, 'class': 'shape' }));
      var name = n.kind === 'entity' && n.type !== 'asset' ? n.id : n.title;
      var text = svg('text', { y: r + 13 });
      text.textContent = short(name, n.ring === 2 ? 20 : 24);
      group.appendChild(text);
      var tip = svg('title', {}); tip.textContent = n.id + (n.title && n.title !== n.id ? '\n' + n.title : '') + '\n' + (n.type || n.kind); group.appendChild(tip);
      group.addEventListener('click', function () { if (!S.moved && n.id !== S.sel) { open(n.id); } });
      group.addEventListener('mouseenter', function () { highlight(n.id); });
      group.addEventListener('mouseleave', function () { highlight(null); });
      nodeLayer.appendChild(group);
    });
    root.appendChild(edgeLayer);
    root.appendChild(nodeLayer);
    fitGraph(pos);

    var legend = $('legend');
    clear(legend);
    var seenTypes = {}, seenRelations = {};
    g.nodes.forEach(function (n) { seenTypes[typeClass(n)] = n.kind === 'entity' ? (n.type === 'asset' ? 'file' : 'entity') : n.type; });
    g.edges.forEach(function (e) { seenRelations[e.relation] = true; });
    Object.keys(seenTypes).forEach(function (cls) {
      var item = el('span', cls); item.appendChild(el('span', 'dot')); item.appendChild(el('span', '', seenTypes[cls])); legend.appendChild(item);
    });
    Object.keys(seenRelations).sort().forEach(function (relation) {
      var item = el('span', 'r-' + relation); item.appendChild(el('span', 'ln')); item.appendChild(el('span', '', relation)); legend.appendChild(item);
    });
    $('graphNote').textContent = g.hidden > 0 ? g.hidden + ' more relations of this node are not drawn; the table below lists them.' : '';
  }
  function highlight(id) {
    var root = $('graph');
    root.classList.toggle('hl', !!id);
    var on = {};
    if (id) { on[id] = true; }
    var edges = root.querySelectorAll('.edge, .elabel');
    for (var i = 0; i < edges.length; i++) {
      var hit = !!id && (edges[i].dataset.from === id || edges[i].dataset.to === id);
      edges[i].classList.toggle('on', hit);
      if (hit) { on[edges[i].dataset.from] = true; on[edges[i].dataset.to] = true; }
    }
    var nodes = root.querySelectorAll('.gn');
    for (var j = 0; j < nodes.length; j++) { nodes[j].classList.toggle('on', !!on[nodes[j].dataset.id]); }
  }
  function wireGraph() {
    var wrap = $('graphWrap');
    var drag = null;
    wrap.addEventListener('wheel', function (event) {
      if (!S.view) { return; }
      event.preventDefault();
      var box = wrap.getBoundingClientRect();
      var fx = (event.clientX - box.left) / box.width, fy = (event.clientY - box.top) / box.height;
      var k = event.deltaY > 0 ? 1.15 : 1 / 1.15;
      var w = Math.min(Math.max(S.view.w * k, 200), 12000), h = w * S.view.h / S.view.w;
      setView({ x: S.view.x + (S.view.w - w) * fx, y: S.view.y + (S.view.h - h) * fy, w: w, h: h });
    }, { passive: false });
    wrap.addEventListener('mousedown', function (event) {
      if (!S.view) { return; }
      // The resize grip sits in the bottom-right corner: a press there resizes, it does not pan.
      var box = wrap.getBoundingClientRect();
      if (box.right - event.clientX < 20 && box.bottom - event.clientY < 20) { return; }
      drag = { x: event.clientX, y: event.clientY, view: S.view };
      S.moved = false;
    });
    // After a resize (the grip, or the panel) the frame's ratio changed: keep the
    // view's width and centre and give it the frame's new height, so that wheel
    // and drag keep mapping pixels to graph units.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () {
        if (!S.view) { return; }
        var box = wrap.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) { return; }
        var h = S.view.w * box.height / box.width;
        if (Math.abs(h - S.view.h) < 0.5) { return; }
        setView({ x: S.view.x, y: S.view.y + (S.view.h - h) / 2, w: S.view.w, h: h });
      }).observe(wrap);
    }
    window.addEventListener('mousemove', function (event) {
      if (!drag) { return; }
      var box = wrap.getBoundingClientRect();
      var dx = (event.clientX - drag.x) * drag.view.w / box.width, dy = (event.clientY - drag.y) * drag.view.h / box.height;
      if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 4) { S.moved = true; wrap.classList.add('drag'); }
      setView({ x: drag.view.x - dx, y: drag.view.y - dy, w: drag.view.w, h: drag.view.h });
    });
    window.addEventListener('mouseup', function () {
      drag = null;
      wrap.classList.remove('drag');
      setTimeout(function () { S.moved = false; }, 0);
    });
    $('fit').onclick = function () { if (S.pos) { fitGraph(S.pos); } };
    $('depth2').onchange = function () {
      S.depth = $('depth2').checked ? 2 : 1;
      if (S.sel) { post({ type: 'graph', id: S.sel, depth: S.depth }); }
    };
  }

  // ── overview ────────────────────────────────────────────────────────────
  function bars(box, entries, options) {
    clear(box);
    var max = entries.reduce(function (m, e) { return Math.max(m, e.count); }, 1);
    if (entries.length === 0) { box.appendChild(el('div', 'muted', 'none')); }
    entries.forEach(function (entry) {
      var row = el('div', 'bar1' + (options && options.cls ? ' ' + options.cls(entry.name) : '') + (options && options.pick ? ' link' : ''));
      var label = el('div', 'lab');
      if (options && options.dot) { label.appendChild(el('span', 'dot')); }
      label.appendChild(el('span', '', entry.name));
      label.title = entry.name;
      row.appendChild(label);
      var track = el('div', 'track');
      var fill = el('div', 'fill');
      fill.style.width = Math.max(1, Math.round(100 * entry.count / max)) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('div', 'num', entry.count.toLocaleString()));
      if (options && options.pick) { row.onclick = function () { options.pick(entry.name); }; }
      box.appendChild(row);
    });
  }
  function renderOverview(o, fileFacts, file) {
    var cards = $('ovCards');
    clear(cards);
    var entityCount = o.entities.reduce(function (sum, e) { return sum + e.count; }, 0);
    var relationCount = o.relations.reduce(function (sum, e) { return sum + e.count; }, 0);
    var reviewed = (o.byStatus.filter(function (s) { return s.name === 'reviewed'; })[0] || { count: 0 }).count;
    [[o.units, 'knowledge units'], [reviewed, 'reviewed'], [o.incomplete, 'without text yet'], [entityCount, 'entities'], [relationCount, 'relations']]
      .forEach(function (pair) {
        var card = el('div', 'card');
        card.appendChild(el('div', 'v', pair[0].toLocaleString()));
        card.appendChild(el('div', 'k', pair[1]));
        cards.appendChild(card);
      });
    var filterBy = function (apply) {
      return function (name) {
        S.types = {}; S.domain = ''; S.collection = ''; apply(name);
        $('domain').value = S.domain; $('collection').value = S.collection; renderChips(); renderList(); showTab('units');
      };
    };
    bars($('ovType'), o.byType, { dot: true, cls: function (name) { return 't-' + name; }, pick: filterBy(function (name) { S.types[name] = true; }) });
    bars($('ovDomain'), o.byDomain, { pick: filterBy(function (name) { S.domain = name; }) });
    bars($('ovCollection'), o.byCollection || [], { pick: filterBy(function (name) { S.collection = name; }) });
    bars($('ovTool'), o.byTool, {});
    bars($('ovStatus'), o.byStatus, {});
    bars($('ovEntities'), o.entities, {});
    bars($('ovRelations'), o.relations, { cls: function (name) { return 'r-' + name; } });
    var routes = $('ovRoutes');
    clear(routes);
    if (o.routes.length === 0) { routes.appendChild(el('div', 'muted', 'This index has no routing units.')); }
    o.routes.forEach(function (route) {
      var card = el('div', 'route');
      card.appendChild(el('b', '', route.title));
      card.appendChild(el('span', 'muted', route.summary));
      card.onclick = function () { open(route.id); };
      routes.appendChild(card);
    });
    var info = $('ovInfo');
    clear(info);
    var rows = [['file', file], ['size and date', fileFacts]];
    Object.keys(o.info).sort().forEach(function (key) { rows.push([key, o.info[key]]); });
    rows.forEach(function (pair) {
      if (!pair[1]) { return; }
      var tr = el('tr');
      tr.appendChild(el('td', '', pair[0]));
      tr.appendChild(el('td', '', pair[1]));
      info.appendChild(tr);
    });
  }

  // ── search ──────────────────────────────────────────────────────────────
  var timer = null;
  function search(now) {
    clearTimeout(timer);
    timer = setTimeout(function () {
      S.query = $('query').value.trim();
      if (!S.query) { S.hits = null; S.marks = {}; $('searchNote').textContent = ''; renderList(); return; }
      S.seq += 1;
      post({ type: 'search', seq: S.seq, query: S.query, context: $('useContext').checked });
    }, now ? 0 : 220);
  }

  // ── messages ────────────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var m = event.data || {};
    if (m.type === 'index') {
      $('unavailable').hidden = true;
      S.units = m.units; S.byId = {}; S.overview = m.overview;
      m.units.forEach(function (u) { S.byId[u.id] = u; });
      $('indexFacts').textContent = m.fileName + (m.fileFacts ? ' · ' + m.fileFacts : '');
      $('indexFacts').title = m.file;
      $('unitsBadge').textContent = m.units.length;
      var domain = $('domain');
      clear(domain);
      var all = el('option', '', 'all domains'); all.value = ''; domain.appendChild(all);
      m.overview.byDomain.forEach(function (entry) { var option = el('option', '', entry.name + ' (' + entry.count + ')'); option.value = entry.name; domain.appendChild(option); });
      domain.value = S.domain;
      var collection = $('collection');
      clear(collection);
      var any = el('option', '', 'all collections'); any.value = ''; collection.appendChild(any);
      (m.overview.byCollection || []).forEach(function (entry) { var option = el('option', '', entry.name + ' (' + entry.count + ')'); option.value = entry.name; collection.appendChild(option); });
      collection.value = S.collection;
      renderChips(); renderList(); renderOverview(m.overview, m.fileFacts, m.file);
      if (S.query) { search(true); }
      if (S.sel) { open(S.sel, true); } else { showTab(document.querySelector('.tabs button.active').dataset.tab); }
    } else if (m.type === 'unit') {
      if (m.detail.id === S.sel) { renderDetail(m.detail); }
    } else if (m.type === 'missing') {
      $('searchNote').textContent = 'The index has no ' + m.id + '.';
    } else if (m.type === 'graph') {
      if (m.graph.centre === S.sel) { renderGraph(m.graph); }
    } else if (m.type === 'search') {
      if (m.seq !== S.seq || !m.result) { return; }
      S.hits = m.result.ids; S.marks = {};
      m.result.unverified.forEach(function (id) { S.marks[id] = 'unverified'; });
      m.result.exact.forEach(function (id) { S.marks[id] = 'exact'; });
      var note = m.result.ids.length + ' of ' + m.result.matched + ' matches, best first';
      if (m.result.context) { note += ' · filtered for ' + m.result.context; }
      if (m.result.note) { note += ' · not filtered: ' + m.result.note; }
      $('searchNote').textContent = note;
      renderList();
    } else if (m.type === 'unavailable') {
      $('unavailable').hidden = false;
      $('units').classList.remove('active'); $('overview').classList.remove('active');
      $('unavailableText').textContent = m.message;
      $('unavailableHint').textContent = (m.file ? 'Index file: ' + m.file + '. ' : '') + m.hint;
      $('indexFacts').textContent = '';
    }
  });

  // ── wiring ──────────────────────────────────────────────────────────────
  var tabButtons = document.querySelectorAll('.tabs button');
  for (var i = 0; i < tabButtons.length; i++) { tabButtons[i].onclick = function () { if ($('unavailable').hidden) { showTab(this.dataset.tab); } }; }
  var subButtons = document.querySelectorAll('.subtabs button');
  for (var j = 0; j < subButtons.length; j++) { subButtons[j].onclick = function () { showSub(this.dataset.sub); }; }
  $('list').addEventListener('click', function (event) {
    var row = event.target.closest ? event.target.closest('.row') : null;
    if (row && row.dataset.id) { open(row.dataset.id); }
  });
  $('list').addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') { return; }
    var shown = visibleUnits().slice(0, MAX_ROWS);
    var at = shown.map(function (u) { return u.id; }).indexOf(S.sel);
    var next = shown[Math.min(Math.max(at + (event.key === 'ArrowDown' ? 1 : -1), 0), shown.length - 1)];
    if (next) { event.preventDefault(); open(next.id); }
  });
  $('dBody').addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('a') : null;
    if (!link) { return; }
    event.preventDefault();
    if (link.dataset.id) { open(link.dataset.id); } else if (link.dataset.url) { post({ type: 'open.external', url: link.dataset.url }); }
  });
  $('query').addEventListener('input', function () { search(false); });
  $('query').addEventListener('keydown', function (event) { if (event.key === 'Enter') { search(true); } });
  $('useContext').onchange = function () { if (S.query) { search(true); } };
  $('domain').onchange = function () { S.domain = $('domain').value; renderList(); };
  $('collection').onchange = function () { S.collection = $('collection').value; renderList(); };
  $('hideIncomplete').onchange = function () { S.hideIncomplete = $('hideIncomplete').checked; renderList(); };
  $('back').onclick = function () { step(S.back, S.fwd); };
  $('forward').onclick = function () { step(S.fwd, S.back); };
  $('copyId').onclick = function () { if (S.sel) { post({ type: 'copy', text: S.sel }); $('copyId').textContent = 'copied'; setTimeout(function () { $('copyId').textContent = 'copy'; }, 900); } };
  $('openSource').onclick = function () { if (S.sel) { post({ type: 'open.source', id: S.sel }); } };
  $('reload').onclick = function () { post({ type: 'reload' }); };
  $('retry').onclick = function () { post({ type: 'reload' }); };
  $('openSettings').onclick = function () { post({ type: 'settings' }); };
  wireGraph();
  post({ type: 'ready' });
})();
`;
