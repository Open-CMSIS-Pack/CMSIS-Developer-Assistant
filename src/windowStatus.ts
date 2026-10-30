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
 * Window selection for people (#16): the status-bar item every window shows
 * while its coordinator runs, and the Select Target Window quick pick behind
 * its click. What they show is computed in src/core/windowStatus.ts; this
 * module keeps the state it is computed from and puts it on screen.
 *
 * The state has three sources. The control server's op hook says when an
 * agent call starts, outlives its fence (#14) and ends in this window. The
 * router's MCP server lists its sessions and their target windows. The
 * default target is read from the registry directory on the coordinator's
 * heartbeat, and at once in the window where the user chose it. A
 * five-second tick keeps the times in the tooltip current; nothing is
 * assigned to the item unless it changed, and the warning background is
 * made only while a call is past its fence.
 */

import * as vscode from 'vscode';
import type { OpPhase } from './controlServer';
import { mayWaitForUser, type OpName } from './core/opTable';
import {
    DefaultTargetView,
    RunningCall,
    SessionView,
    WindowStatusView,
    defaultTargetText,
    renderWindowStatus,
    targetChoices,
    toolNameOf,
} from './core/windowStatus';
import { logger } from './utils/logger';
import { notifyWarning } from './utils/notify';
import type { WindowRole, WorkspaceRegistry } from './utils/workspaceRegistry';

/** The command behind the item's click; contributed in package.json. */
export const SELECT_TARGET_WINDOW_COMMAND = 'cmsis-developer-assistant.selectTargetWindow';

const PRODUCT = 'CMSIS Developer Assistant';
/** The item's id; its name is PRODUCT, so the status bar's own menu can hide it. */
const STATUS_ITEM_ID = 'cmsis-developer-assistant.window';
/** Right-hand side, before items of lower priority. */
const STATUS_PRIORITY = 100;
/** How often the times in the tooltip are brought up to date. */
const TICK_MS = 5_000;
const PICK_TITLE = 'Select Target Window';
/** The theme colour of the item while a call is past its fence (#14). */
const WARNING_BACKGROUND = 'statusBarItem.warningBackground';

/** A running call as this item tracks it: the ticket the control server gave its run, when it named one. */
type TrackedCall = RunningCall & { ticket?: number };

/** What the item reads from its window's coordinator. */
export interface WindowStatusSource {
    readonly registry: WorkspaceRegistry;
    role(): WindowRole;
    /** The agents' MCP URL. */
    endpoint(): string;
    /** The router's open MCP sessions; undefined in a worker. */
    sessions(): readonly SessionView[] | undefined;
}

/** The status-bar item of one window and the quick pick behind it. */
export class WindowStatus {
    private readonly item: vscode.StatusBarItem;
    private readonly ticker: ReturnType<typeof setInterval>;
    private readonly running: TrackedCall[] = [];
    private lastCall: { tool: string; at: number } | undefined;
    private chosen: DefaultTargetView | undefined;
    private shown: WindowStatusView | undefined;

    constructor(private readonly source: WindowStatusSource) {
        this.item = vscode.window.createStatusBarItem(STATUS_ITEM_ID, vscode.StatusBarAlignment.Right, STATUS_PRIORITY);
        this.item.name = PRODUCT;
        this.item.command = SELECT_TARGET_WINDOW_COMMAND;
        this.chosen = this.readChosen();
        this.render();
        this.item.show();
        this.ticker = setInterval(() => this.render(), TICK_MS);
        // A tick is never a reason to keep a process alive.
        this.ticker.unref();
    }

    /**
     * The control server's op hook: an agent call starts in this window,
     * outlives its fence, or ends. `ticket` tells two runs of one tool apart;
     * without it the oldest run of the tool is meant.
     */
    noteOp(op: OpName, phase: OpPhase, ticket?: number): void {
        const tool = toolNameOf(op);
        const now = Date.now();
        const at = this.running.findIndex((call) => call.tool === tool && (ticket === undefined || call.ticket === ticket));
        if (phase === 'start') {
            this.running.push(ticket === undefined ? { tool, since: now } : { tool, since: now, ticket });
        } else if (phase === 'fenced') {
            if (at >= 0) {
                this.running[at].fenced = true;
                this.running[at].waitsForUser = mayWaitForUser(op);
            }
        } else {
            if (at >= 0) {
                this.running.splice(at, 1);
            }
            this.lastCall = { tool, at: now };
        }
        this.render();
    }

    /** Read the default target again (the heartbeat, a choice made here) and show it. */
    reloadDefault(): void {
        this.chosen = this.readChosen();
        this.render();
    }

    /** Bring the item up to date; a property is assigned only when its value changed. */
    render(): void {
        const view = renderWindowStatus({
            role: this.source.role(),
            pid: this.source.registry.ownPid(),
            endpoint: this.source.endpoint(),
            defaultTarget: this.chosen,
            running: this.running,
            lastCall: this.lastCall,
            sessions: this.source.sessions(),
            now: Date.now(),
        });
        if (this.shown?.text !== view.text) {
            this.item.text = view.text;
        }
        if (this.shown?.tooltip !== view.tooltip) {
            this.item.tooltip = view.tooltip;
        }
        if ((this.shown?.warning ?? false) !== view.warning) {
            this.item.backgroundColor = view.warning ? new vscode.ThemeColor(WARNING_BACKGROUND) : undefined;
        }
        this.shown = view;
    }

    /**
     * Select Target Window: pick a registered window, or Automatic, and save
     * the choice for every router to read; dismissing the pick changes nothing.
     */
    async chooseTarget(): Promise<void> {
        const registry = this.source.registry;
        this.chosen = this.readChosen();
        const ownPid = registry.ownPid();
        const picked = await vscode.window.showQuickPick(targetChoices(registry.list(), this.chosen, ownPid), {
            title: PICK_TITLE,
            placeHolder: `The window agent calls go to when nothing else names one. Now: ${defaultTargetText(this.chosen, ownPid)}`,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (picked === undefined) {
            return;
        }
        const entry = picked.window;
        try {
            if (entry === undefined) {
                await registry.clearDefaultTarget();
                logger.info('Default target window cleared: agents choose automatically');
            } else {
                const folders = Array.isArray(entry.workspaceFolders) ? entry.workspaceFolders : [];
                await registry.writeDefaultTarget({ pid: entry.pid, workspaceFolder: folders[0], name: entry.name, setAt: Date.now() });
                logger.info(`Default target window set to pid=${entry.pid} (${entry.name})`);
            }
        } catch (failure) {
            logger.error('Could not save the default target window', failure);
            const reason = failure instanceof Error ? failure.message : String(failure);
            void notifyWarning(`${PRODUCT}: the target window could not be saved: ${reason}`);
            return;
        }
        this.reloadDefault();
    }

    /** Stop the tick and take the item out of the status bar. */
    dispose(): void {
        clearInterval(this.ticker);
        this.item.dispose();
    }

    /** The default target as saved, with the pid of its window while that is open. */
    private readChosen(): DefaultTargetView | undefined {
        const registry = this.source.registry;
        const saved = registry.readDefaultTarget();
        if (saved === undefined) {
            return undefined;
        }
        const open = registry.findDefaultTarget(saved);
        return { name: open?.name ?? saved.name ?? `pid ${saved.pid}`, pid: open?.pid };
    }
}
