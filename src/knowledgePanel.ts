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
 * The knowledge browser: a webview that shows what the knowledge index
 * holds, for the people who write and review it. It reads the index the
 * knowledge tools read and changes nothing.
 *
 *  - Units: every unit as a list with filters by type, domain and state and
 *    the search of `knowledge_search`; beside it the selected node with its
 *    text, the files it ships, its relations as a graph that can be walked,
 *    and its frontmatter.
 *  - Overview: how many units of which type, domain, tool and state, the
 *    entities and relations of the graph, the facts of the index file, and
 *    the routing units as places to start.
 *
 * The data comes from `core/knowledge/browse.ts`; this file wires messages
 * and holds the page. The page renders text from Markdown files of any
 * author: the HTML it gets is built from escaped text, the page's own script
 * runs under a nonce, and the two things the page can ask VS Code to do
 * (open a file, open a link) are checked here.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { detailOf, graphAround, overviewOf, unitRows } from './core/knowledge/browse';
import { KNOWLEDGE_PANEL_SCRIPT, KNOWLEDGE_PANEL_STYLE } from './knowledgePanelPage';
import { toToolError } from './core/toolResult';
import type { KnowledgeHandler } from './knowledgeHandler';
import type { PackDocsLog } from './core/packDocs';

const SETTINGS_QUERY = 'cmsis-developer-assistant.knowledge';

/** A link the page may ask to open in the browser: http or https, nothing else. */
export function externalUrl(requested: unknown): string | undefined {
    if (typeof requested !== 'string' || requested.length > 2_000) {
        return undefined;
    }
    try {
        const url = new URL(requested);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

/** The depth the graph is asked for: 1, or 2 when the page says so. */
export function graphDepth(requested: unknown): number {
    return requested === 2 ? 2 : 1;
}

export class KnowledgePanel {
    private static current: KnowledgePanel | undefined;

    static show(context: vscode.ExtensionContext, knowledge: KnowledgeHandler, log: PackDocsLog): void {
        if (KnowledgePanel.current) {
            KnowledgePanel.current.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel('cmsisKnowledgePanel', 'CMSIS Knowledge', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        KnowledgePanel.current = new KnowledgePanel(panel, knowledge, log);
        context.subscriptions.push(panel);
    }

    private constructor(private readonly panel: vscode.WebviewPanel, private readonly knowledge: KnowledgeHandler, private readonly log: PackDocsLog) {
        panel.webview.html = this.html();
        panel.webview.onDidReceiveMessage((message: { type?: unknown; [key: string]: unknown }) => void this.onMessage(message));
        panel.onDidDispose(() => {
            KnowledgePanel.current = undefined;
        });
    }

    private post(message: object): void {
        void this.panel.webview.postMessage(message);
    }

    /** The index could not be read: the page shows why and what to do. */
    private unavailable(failure: unknown): void {
        const error = toToolError(failure);
        this.post({ type: 'unavailable', message: error.message, hint: error.hint ?? '', file: this.knowledge.indexFile() ?? '' });
    }

    private async sendIndex(): Promise<void> {
        try {
            const index = await this.knowledge.browseIndex();
            const rows = unitRows(index);
            const file = this.knowledge.indexFile() ?? '';
            let fileFacts = '';
            try {
                const stat = fs.statSync(file);
                fileFacts = `${(stat.size / 1e6).toFixed(1)} MB, built ${stat.mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
            } catch {
                // The index is open, so the file was there a moment ago; the facts are a convenience.
            }
            const extra = index.sources().slice(1);
            if (extra.length > 0) {
                fileFacts = `${fileFacts}${fileFacts ? '; ' : ''}with ${extra.map((source) => `${source.label} (${source.units} units)`).join(', ')}`;
            }
            this.post({ type: 'index', units: rows, overview: overviewOf(index, rows), file, fileName: path.basename(file), fileFacts });
        } catch (failure) {
            this.unavailable(failure);
        }
    }

    private async onMessage(message: { type?: unknown; [key: string]: unknown }): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                case 'reload':
                    await this.sendIndex();
                    break;
                case 'unit': {
                    const id = typeof message.id === 'string' ? message.id : '';
                    const detail = detailOf(await this.knowledge.browseIndex(), id);
                    this.post(detail ? { type: 'unit', detail } : { type: 'missing', id });
                    break;
                }
                case 'graph': {
                    const id = typeof message.id === 'string' ? message.id : '';
                    const graph = graphAround(await this.knowledge.browseIndex(), id, graphDepth(message.depth));
                    if (graph) {
                        this.post({ type: 'graph', graph });
                    }
                    break;
                }
                case 'search': {
                    const query = typeof message.query === 'string' ? message.query.trim() : '';
                    const result = query.length > 0 ? await this.knowledge.browseSearch(query, message.context === true) : undefined;
                    this.post({ type: 'search', seq: message.seq, query, result });
                    break;
                }
                case 'copy':
                    if (typeof message.text === 'string' && message.text.length < 10_000) {
                        await vscode.env.clipboard.writeText(message.text);
                    }
                    break;
                case 'open.external': {
                    const url = externalUrl(message.url);
                    if (url) {
                        await vscode.env.openExternal(vscode.Uri.parse(url));
                    }
                    break;
                }
                case 'open.source': {
                    // Only the file the index itself names for this unit, and only when it is on this machine. A relative
                    // path starts in the folder above the index the unit came from: a pack's folder for .knowledge/knowledge.db.
                    const id = typeof message.id === 'string' ? message.id : '';
                    const browsed = await this.knowledge.browseIndex();
                    const source = detailOf(browsed, id)?.sourcePath;
                    const index = browsed.fileOf(id) ?? this.knowledge.indexFile();
                    const file = source && index && !path.isAbsolute(source) ? path.resolve(path.dirname(index), '..', source) : source;
                    if (file && fs.existsSync(file)) {
                        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
                    } else {
                        void vscode.window.showInformationMessage(`CMSIS Developer Assistant: the source of ${id} is not on this machine${source ? ` (${source})` : ''}.`);
                    }
                    break;
                }
                case 'settings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', SETTINGS_QUERY);
                    break;
                default:
                    this.log.warn(`Knowledge panel: ignored a message of type ${JSON.stringify(message.type)}`);
            }
        } catch (failure) {
            this.unavailable(failure);
        }
    }

    private html(): string {
        const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
        return knowledgePanelHtml(nonce);
    }
}

/** The page of the knowledge browser; `nonce` admits its one script. */
export function knowledgePanelHtml(nonce: string): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>CMSIS Knowledge</title>
<style>${KNOWLEDGE_PANEL_STYLE}</style>
</head>
<body>
<div class="header">
  <div class="bar">
    <span class="brand">CMSIS Knowledge</span>
    <span id="indexFacts" class="muted"></span>
    <span class="grow"></span>
    <label class="check" title="Filter the search by the device, core, compiler and components of the active target, as knowledge_search does"><input type="checkbox" id="useContext"> active project</label>
    <button class="btn ghost" id="reload" title="Read the index file again">Reload</button>
  </div>
  <div class="tabs">
    <button data-tab="units" class="active">Units <span class="badge" id="unitsBadge"></span></button>
    <button data-tab="overview">Overview</button>
  </div>
</div>

<div id="unavailable" class="view empty" hidden>
  <div class="emptybox">
    <h2>No knowledge index to show</h2>
    <p id="unavailableText"></p>
    <p id="unavailableHint" class="muted"></p>
    <p><button class="btn" id="openSettings">Open the knowledge settings</button> <button class="btn ghost" id="retry">Try again</button></p>
  </div>
</div>

<div id="units" class="view active">
  <div id="side">
    <div class="search"><input id="query" type="search" placeholder="Search: a question, or the exact error text" spellcheck="false"><span id="searchNote" class="muted"></span></div>
    <div id="typeChips" class="chips"></div>
    <div class="filters">
      <select id="domain" title="Domain"></select>
      <select id="collection" title="Collection: the source the units come from"></select>
      <label class="check"><input type="checkbox" id="hideIncomplete"> hide units without text</label>
      <span class="grow"></span><span id="listCount" class="muted"></span>
    </div>
    <div id="list" tabindex="0"></div>
  </div>
  <div id="main">
    <div id="detailEmpty" class="emptybox">
      <h2>Pick a unit</h2>
      <p class="muted">Choose one from the list, search for an error message, or start from a routing unit in the Overview.</p>
    </div>
    <div id="detail" hidden>
      <div class="dhead">
        <div class="nav"><button class="btn ghost" id="back" title="Back" disabled>←</button><button class="btn ghost" id="forward" title="Forward" disabled>→</button></div>
        <div class="dtitle">
          <div class="line1"><span id="dType" class="pill"></span><h2 id="dTitle"></h2></div>
          <div class="line2"><code id="dId"></code><a id="copyId" title="Copy the id">copy</a><span id="dBadges"></span><a id="openSource" hidden>open source file</a></div>
        </div>
      </div>
      <p id="dSummary" class="summary"></p>
      <div id="dFiles" class="chips"></div>
      <div class="subtabs">
        <button data-sub="text" class="active">Text</button>
        <button data-sub="graph">Relations <span class="badge" id="relBadge"></span></button>
        <button data-sub="meta">Details</button>
      </div>
      <div id="sub-text" class="sub active"><div id="dBody" class="md"></div></div>
      <div id="sub-graph" class="sub">
        <div class="gbar">
          <span class="muted">Click a node to open it.</span>
          <span class="grow"></span>
          <label class="check"><input type="checkbox" id="depth2"> two hops</label>
          <button class="btn ghost" id="fit">Fit</button>
        </div>
        <div id="graphWrap"><svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg></div>
        <div id="legend" class="legend"></div>
        <div id="graphNote" class="muted"></div>
        <table id="relTable"></table>
      </div>
      <div id="sub-meta" class="sub"><table id="metaTable" class="kv"></table></div>
    </div>
  </div>
</div>

<div id="overview" class="view">
  <div id="ovCards" class="cards"></div>
  <div class="ovgrid">
    <section><h3>Units by type</h3><div id="ovType" class="bars"></div></section>
    <section><h3>Units by domain</h3><div id="ovDomain" class="bars"></div></section>
    <section><h3>Units by collection</h3><div id="ovCollection" class="bars"></div></section>
    <section><h3>Troubleshooting by tool</h3><div id="ovTool" class="bars"></div></section>
    <section><h3>Review state</h3><div id="ovStatus" class="bars"></div></section>
  </div>
  <h3>Start here</h3>
  <div id="ovRoutes" class="routes"></div>
  <div class="ovgrid">
    <section><h3>Entities of the graph</h3><div id="ovEntities" class="bars"></div></section>
    <section><h3>Relations</h3><div id="ovRelations" class="bars"></div></section>
  </div>
  <h3>Index file</h3>
  <table id="ovInfo" class="kv"></table>
</div>

<script nonce="${nonce}">${KNOWLEDGE_PANEL_SCRIPT}</script>
</body>
</html>`;
}
