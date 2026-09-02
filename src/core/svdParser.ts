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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

/**
 * CMSIS-SVD reader: finds the device description for a debug session or a
 * workspace, parses it without an XML dependency, and answers name and
 * address questions about peripherals and registers.
 *
 * Parsed: peripherals (with `derivedFrom`, `addressBlock`s), registers
 * (`dim` arrays expanded), fields (both `bitRange` and `bitOffset`/`bitWidth`,
 * `enumeratedValues`). Not parsed: `cluster`s (their registers are read with
 * cluster-relative offsets), register-level `derivedFrom`, `derivedFrom` on
 * `enumeratedValues`, `dimArrayIndex`.
 */

// ── SVD data types ──────────────────────────────────────────────

export interface SvdEnumeratedValue {
    name: string;
    value: number;
    description?: string;
}

export interface SvdField {
    name: string;
    bitHigh: number;
    bitLow: number;
    description?: string;
    access?: string;
    enumeratedValues?: SvdEnumeratedValue[];
}

export interface SvdRegister {
    name: string;
    addressOffset: number;
    size: number;
    description?: string;
    access?: string;
    resetValue?: number;
    fields: SvdField[];
}

export interface SvdAddressBlock {
    offset: number;
    size: number;
    usage?: string;
}

export interface SvdPeripheral {
    name: string;
    baseAddress: number;
    description?: string;
    registers: SvdRegister[];
    addressBlocks: SvdAddressBlock[];
    /** The peripheral this one was derived from, when the SVD says so. */
    derivedFrom?: string;
}

export interface SvdDevice {
    name: string;
    peripherals: SvdPeripheral[];
}

// ── Cached parse results ────────────────────────────────────────

/**
 * Keyed by path so a session-less lookup of one SVD never evicts the one the
 * active session is reading. Cleared when a debug session ends
 * (extension.ts) — the next session may target a different device.
 */
const cache = new Map<string, SvdDevice>();

export function clearSvdCache(): void {
    cache.clear();
}

// ── SVD file resolution ─────────────────────────────────────────

/** Everything the resolver may consult, injected so the order is testable. */
export interface SvdResolveContext {
    /** Explicit path (launch.json `svdFile` or a tool argument); `${CMSIS_PACK_ROOT}` allowed. */
    svdFile?: string;
    /** The session's `cmsis.cbuildRunFile`; `${command:…}` references are skipped. */
    cbuildRunFile?: string;
    /** Picks the SVD entry in a multi-core cbuild-run when given. */
    pname?: string;
    /** Else the entry whose `pname` occurs in the session name. */
    sessionName?: string;
    /** The session's cwd; `<cwd>/out/*.cbuild-run.yml` is scanned. */
    cwd?: string;
    /** Every `.cbuild-run.yml` under `out/` in the workspace. */
    workspaceCbuildRunFiles: () => Promise<string[]>;
    /** Any `.svd` in the workspace; used only when exactly one exists. */
    workspaceSvdFiles: () => Promise<string[]>;
}

export interface SvdResolution {
    path: string | null;
    /** Every location consulted, for the "no SVD found" explanation. */
    tried: string[];
}

/**
 * Locate the SVD, first match wins:
 *   1. the explicit `svdFile`
 *   2. the session's cbuild-run file
 *   3. `<cwd>/out/*.cbuild-run.yml`
 *   4. every `.cbuild-run.yml` under `out/` anywhere in the workspace
 *   5. a single `*.svd` in the workspace
 */
export async function resolveSvdPath(ctx: SvdResolveContext): Promise<SvdResolution> {
    const tried: string[] = [];

    if (ctx.svdFile) {
        const resolved = resolvePackRoot(ctx.svdFile);
        if (fs.existsSync(resolved)) { return { path: resolved, tried }; }
        tried.push(`svdFile ${resolved} (not found)`);
    }

    const scanned = new Set<string>();
    const scan = async (file: string, label: string): Promise<string | null> => {
        if (scanned.has(file)) { return null; }
        scanned.add(file);
        const hit = findSvdInCbuildRun(file, ctx.pname, ctx.sessionName);
        tried.push(`${label} ${file}${hit ? '' : ' (no usable SVD entry)'}`);
        return hit;
    };

    if (ctx.cbuildRunFile && !ctx.cbuildRunFile.startsWith('${command:')) {
        const hit = await scan(ctx.cbuildRunFile, 'cbuild-run');
        if (hit) { return { path: hit, tried }; }
    }

    if (ctx.cwd) {
        const outDir = path.join(ctx.cwd, 'out');
        if (fs.existsSync(outDir)) {
            for (const f of fs.readdirSync(outDir).filter(f => f.endsWith('.cbuild-run.yml'))) {
                const hit = await scan(path.join(outDir, f), 'cbuild-run');
                if (hit) { return { path: hit, tried }; }
            }
        }
    }

    for (const f of (await ctx.workspaceCbuildRunFiles()).slice(0, 10)) {
        const hit = await scan(f, 'cbuild-run');
        if (hit) { return { path: hit, tried }; }
    }

    const svdFiles = await ctx.workspaceSvdFiles();
    if (svdFiles.length === 1) { return { path: svdFiles[0], tried }; }
    tried.push(svdFiles.length === 0
        ? 'workspace *.svd (none)'
        : `workspace *.svd (${svdFiles.length} files — pass svdFile to pick one)`);

    return { path: null, tried };
}

/** The SVD entries of a cbuild-run file, in order. */
export function svdEntriesFromCbuildRun(content: string): { file: string; pname?: string }[] {
    const entries: { file: string; pname?: string }[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const fileLine = lines[i].match(/^\s*-\s*file:\s*(.+)$/);
        if (!fileLine) { continue; }
        const entry: { file: string; pname?: string } = { file: fileLine[1].trim() };
        let isSvd = false;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            if (lines[j].match(/^\s*-\s/)) { break; }
            const typeLine = lines[j].match(/^\s+type:\s*(.+)$/);
            if (typeLine) { isSvd = typeLine[1].trim() === 'svd'; }
            const pnameLine = lines[j].match(/^\s+pname:\s*(.+)$/);
            if (pnameLine) { entry.pname = pnameLine[1].trim(); }
        }
        if (isSvd) { entries.push(entry); }
    }
    return entries;
}

/**
 * Pick the SVD entry: the one whose `pname` matches the requested processor,
 * else the one whose `pname` occurs in the session name, else the first.
 */
export function selectSvdEntry<T extends { pname?: string }>(entries: T[], pname?: string, sessionName?: string): T | undefined {
    if (pname) {
        const wanted = pname.toUpperCase();
        return entries.find(e => e.pname?.toUpperCase() === wanted)
            ?? entries.find(e => e.pname?.toUpperCase().includes(wanted));
    }
    if (sessionName) {
        const upper = sessionName.toUpperCase();
        const hit = entries.find(e => e.pname && upper.includes(e.pname.toUpperCase()));
        if (hit) { return hit; }
    }
    return entries[0];
}

function findSvdInCbuildRun(filePath: string, pname?: string, sessionName?: string): string | null {
    try {
        const entries = svdEntriesFromCbuildRun(fs.readFileSync(filePath, 'utf-8'));
        const entry = selectSvdEntry(entries, pname, sessionName);
        if (!entry) { return null; }
        const resolved = resolvePackRoot(entry.file);
        return fs.existsSync(resolved) ? resolved : null;
    } catch {
        return null;
    }
}

function resolvePackRoot(filePath: string): string {
    if (filePath.includes('${CMSIS_PACK_ROOT}')) {
        const packRoot = process.env.CMSIS_PACK_ROOT
            || path.join(os.homedir(), '.cache', 'arm', 'packs');
        return filePath.replace('${CMSIS_PACK_ROOT}', packRoot);
    }
    return filePath;
}

/** The headless transport harness stubs `vscode.workspace` without findFiles. */
async function workspaceGlob(pattern: string, max: number): Promise<string[]> {
    if (typeof vscode.workspace.findFiles !== 'function') { return []; }
    try {
        const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', max);
        return uris.map(u => u.fsPath);
    } catch {
        return [];
    }
}

function workspaceContext(): Pick<SvdResolveContext, 'workspaceCbuildRunFiles' | 'workspaceSvdFiles'> {
    return {
        workspaceCbuildRunFiles: () => workspaceGlob('out/**/*.cbuild-run.yml', 10),
        workspaceSvdFiles: () => workspaceGlob('**/*.svd', 5),
    };
}

function sessionContext(session: vscode.DebugSession): Partial<SvdResolveContext> {
    const config = session.configuration;
    return {
        svdFile: typeof config.svdFile === 'string' ? config.svdFile : undefined,
        cbuildRunFile: typeof config.cmsis?.cbuildRunFile === 'string' ? config.cmsis.cbuildRunFile : undefined,
        cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
        sessionName: session.name,
    };
}

/** Locate the SVD file for the active debug session; null without one. */
export async function findSvdFile(): Promise<string | null> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return null; }
    return (await resolveSvdPath({ ...sessionContext(session), ...workspaceContext() })).path;
}

/**
 * Locate an SVD for a lookup: the explicit path first, then the active
 * session's sources when there is one, then the workspace — so the lookup
 * tools work before the first session and agree with the reader during one.
 */
export async function resolveSvdForLookup(opts: { svdFile?: string; pname?: string }): Promise<SvdResolution> {
    const session = vscode.debug.activeDebugSession;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return resolveSvdPath({
        ...(session ? sessionContext(session) : { cwd }),
        ...workspaceContext(),
        svdFile: opts.svdFile,
        pname: opts.pname,
    });
}

/** Parse (or reuse) the SVD at `svdPath`. */
export function loadSvdFromPath(svdPath: string): SvdDevice | null {
    const cached = cache.get(svdPath);
    if (cached) { return cached; }
    try {
        const device = parseSvdXml(fs.readFileSync(svdPath, 'utf-8'));
        cache.set(svdPath, device);
        return device;
    } catch {
        return null;
    }
}

/** The active session's device description, or null. */
export async function loadSvd(): Promise<SvdDevice | null> {
    const svdPath = await findSvdFile();
    return svdPath ? loadSvdFromPath(svdPath) : null;
}

export type SvdLookupLoad =
    | { device: SvdDevice; path: string; tried: string[] }
    | { device: null; path: string | null; tried: string[] };

/** The device description for a lookup tool, with what was tried on failure. */
export async function loadSvdForLookup(opts: { svdFile?: string; pname?: string }): Promise<SvdLookupLoad> {
    const resolution = await resolveSvdForLookup(opts);
    if (!resolution.path) { return { device: null, path: null, tried: resolution.tried }; }
    const device = loadSvdFromPath(resolution.path);
    if (!device) {
        return { device: null, path: resolution.path, tried: [...resolution.tried, `${resolution.path} (could not be parsed)`] };
    }
    return { device, path: resolution.path, tried: resolution.tried };
}

// ── XML text helpers (no external dependency) ───────────────────

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Text of the first `<tag>` element — the tag name matched whole, so `dim` never matches `dimIncrement`. */
function extractTag(xml: string, tag: string): string | null {
    const re = new RegExp(`<${escapeRe(tag)}(?:\\s[^>]*)?>([^<]*)</${escapeRe(tag)}>`);
    const m = xml.match(re);
    return m ? m[1].trim() : null;
}

/** Every `<tag …>…</tag>` block, non-nested, tag name matched whole. */
function extractBlocks(xml: string, tag: string): string[] {
    const blocks: string[] = [];
    const open = new RegExp(`<${escapeRe(tag)}(?=[\\s>])`, 'g');
    const close = `</${tag}>`;
    let m: RegExpExecArray | null;
    while ((m = open.exec(xml)) !== null) {
        const end = xml.indexOf(close, m.index);
        if (end === -1) { break; }
        blocks.push(xml.substring(m.index, end + close.length));
        open.lastIndex = end + close.length;
    }
    return blocks;
}

/** `xml` with every `<tag>…</tag>` block removed, so a parent's own tags can be read without picking up a child's. */
function withoutBlocks(xml: string, tag: string): string {
    const open = new RegExp(`<${escapeRe(tag)}(?=[\\s>])`);
    const close = `</${tag}>`;
    let out = xml;
    for (;;) {
        const m = open.exec(out);
        if (!m) { return out; }
        const end = out.indexOf(close, m.index);
        if (end === -1) { return out; }
        out = out.substring(0, m.index) + out.substring(end + close.length);
    }
}

function extractAttr(xml: string, attr: string): string | null {
    const re = new RegExp(`${attr}="([^"]+)"`);
    const m = xml.match(re);
    return m ? m[1] : null;
}

function parseHex(s: string): number {
    s = s.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) { return parseInt(s, 16); }
    if (s.startsWith('#')) { return parseInt(s.slice(1).replace(/x/gi, '0'), 2); }
    return parseInt(s, 10);
}

// ── Core parsing ────────────────────────────────────────────────

export function parseSvdXml(xml: string): SvdDevice {
    const deviceName = extractTag(withoutBlocks(xml, 'peripherals'), 'name') || extractTag(xml, 'name') || 'unknown';
    const peripheralBlocks = extractBlocks(xml, 'peripheral');

    // First pass builds the map so a derived peripheral can find its parent.
    const peripheralMap = new Map<string, SvdPeripheral>();
    const orderedPeripherals: SvdPeripheral[] = [];

    for (const pBlock of peripheralBlocks) {
        const own = withoutBlocks(pBlock, 'registers');
        const name = extractTag(own, 'name');
        if (!name) { continue; }

        const baseAddrStr = extractTag(own, 'baseAddress');
        const baseAddress = baseAddrStr ? parseHex(baseAddrStr) : 0;
        const derivedFrom = extractAttr(pBlock.substring(0, pBlock.indexOf('>')), 'derivedFrom');
        const parent = derivedFrom ? peripheralMap.get(derivedFrom) : undefined;
        const description = extractTag(withoutBlocks(own, 'addressBlock'), 'description') || parent?.description || undefined;

        let registers: SvdRegister[] = extractBlocks(pBlock, 'register').flatMap(parseSvdRegister);
        if (registers.length === 0 && parent) {
            registers = parent.registers; // shared reference is fine (read-only)
        }

        let addressBlocks = extractBlocks(own, 'addressBlock').map(parseAddressBlock);
        if (addressBlocks.length === 0 && parent) {
            addressBlocks = parent.addressBlocks;
        }

        const peripheral: SvdPeripheral = { name, baseAddress, description, registers, addressBlocks, ...(derivedFrom ? { derivedFrom } : {}) };
        peripheralMap.set(name, peripheral);
        orderedPeripherals.push(peripheral);
    }

    return { name: deviceName, peripherals: orderedPeripherals };
}

function parseAddressBlock(xml: string): SvdAddressBlock {
    const offsetStr = extractTag(xml, 'offset');
    const sizeStr = extractTag(xml, 'size');
    return {
        offset: offsetStr ? parseHex(offsetStr) : 0,
        size: sizeStr ? parseHex(sizeStr) : 0,
        usage: extractTag(xml, 'usage') || undefined,
    };
}

/** `dimIndex` is either a range `1-4` or a list `A,B,C`. */
export function expandDimIndex(dimIndex: string | null, dim: number): string[] {
    if (dimIndex) {
        const range = dimIndex.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
        if (range) {
            const from = parseInt(range[1], 10);
            return Array.from({ length: dim }, (_, i) => String(from + i));
        }
        const list = dimIndex.split(',').map(s => s.trim()).filter(Boolean);
        if (list.length >= dim) { return list.slice(0, dim); }
    }
    return Array.from({ length: dim }, (_, i) => String(i));
}

/** One register, or the expanded elements of a `dim` array. */
function parseSvdRegister(regXml: string): SvdRegister[] {
    const own = withoutBlocks(regXml, 'fields');
    const name = extractTag(own, 'name') || 'unknown';
    const offsetStr = extractTag(own, 'addressOffset');
    const addressOffset = offsetStr ? parseHex(offsetStr) : 0;
    const sizeStr = extractTag(own, 'size');
    const size = sizeStr ? parseHex(sizeStr) : 32;
    const description = extractTag(own, 'description') || undefined;
    const access = extractTag(own, 'access') || undefined;
    const resetStr = extractTag(own, 'resetValue');
    const resetValue = resetStr ? parseHex(resetStr) : undefined;

    const fields = extractBlocks(regXml, 'field').map(parseSvdField);
    const base: SvdRegister = { name, addressOffset, size, description, access, resetValue, fields };

    const dimStr = extractTag(own, 'dim');
    const dim = dimStr ? parseInt(dimStr, 10) : 0;
    if (!(dim > 1) && !(dim === 1 && name.includes('%s'))) {
        return [base];
    }
    const incStr = extractTag(own, 'dimIncrement');
    const increment = incStr ? parseHex(incStr) : Math.max(1, size / 8);
    const indices = expandDimIndex(extractTag(own, 'dimIndex'), dim);
    return indices.map((index, i) => ({
        ...base,
        name: name.includes('%s') ? name.replace(/%s/g, index) : `${name}${index}`,
        description: description?.replace(/%s/g, index),
        addressOffset: addressOffset + i * increment,
    }));
}

function parseSvdField(fieldXml: string): SvdField {
    const own = withoutBlocks(fieldXml, 'enumeratedValues');
    const name = extractTag(own, 'name') || 'unknown';
    const description = extractTag(own, 'description') || undefined;
    const access = extractTag(own, 'access') || undefined;

    // Parse bitRange "[hi:lo]" or bitOffset+bitWidth
    let bitHigh = 0;
    let bitLow = 0;
    const bitRange = extractTag(own, 'bitRange');
    if (bitRange) {
        const m = bitRange.match(/\[(\d+):(\d+)\]/);
        if (m) {
            bitHigh = parseInt(m[1], 10);
            bitLow = parseInt(m[2], 10);
        }
    } else {
        const offsetStr = extractTag(own, 'bitOffset');
        const widthStr = extractTag(own, 'bitWidth');
        bitLow = offsetStr ? parseInt(offsetStr, 10) : 0;
        const width = widthStr ? parseInt(widthStr, 10) : 1;
        bitHigh = bitLow + width - 1;
    }

    const enumeratedValues = extractBlocks(fieldXml, 'enumeratedValue')
        .map(ev => ({
            name: extractTag(ev, 'name') || 'unknown',
            value: parseHex(extractTag(ev, 'value') || '0'),
            description: extractTag(ev, 'description') || undefined,
        }))
        .filter(ev => !Number.isNaN(ev.value));

    return { name, bitHigh, bitLow, description, access, ...(enumeratedValues.length ? { enumeratedValues } : {}) };
}

// ── Lookup helpers ──────────────────────────────────────────────

export function findPeripheral(device: SvdDevice, name: string): SvdPeripheral | undefined {
    return device.peripherals.find(p =>
        p.name.toUpperCase() === name.toUpperCase()
    );
}

export function findRegister(peripheral: SvdPeripheral, name: string): SvdRegister | undefined {
    return peripheral.registers.find(r =>
        r.name.toUpperCase() === name.toUpperCase()
    );
}

export function listPeripheralNames(device: SvdDevice): string[] {
    return device.peripherals.map(p => p.name);
}

/**
 * Decode a 32-bit register value into its SVD fields.
 */
export function decodeFields(register: SvdRegister, value: number): { name: string; value: number; bits: string; description?: string }[] {
    return register.fields.map(f => {
        // JS bitwise ops coerce to int32 and `1 << 32` wraps to 1, so a
        // full-word field ([31:0]) needs the >= 32 path explicitly. Shift
        // first (>>> is ToUint32) and mask with 2**width - 1 (exact for
        // width <= 31) so no intermediate is ever a negative int32 and
        // field values never print negative when bit 31 is set.
        const width = f.bitHigh - f.bitLow + 1;
        const fieldValue = width >= 32
            ? value >>> 0
            : ((value >>> f.bitLow) & (2 ** width - 1)) >>> 0;
        return {
            name: f.name,
            value: fieldValue,
            bits: f.bitHigh === f.bitLow ? `[${f.bitLow}]` : `[${f.bitHigh}:${f.bitLow}]`,
            description: f.description,
        };
    });
}
