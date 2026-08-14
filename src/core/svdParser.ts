// Copyright (c) Microsoft Corporation.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

// ── SVD data types ──────────────────────────────────────────────

export interface SvdField {
    name: string;
    bitHigh: number;
    bitLow: number;
    description?: string;
    access?: string;
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

export interface SvdPeripheral {
    name: string;
    baseAddress: number;
    description?: string;
    registers: SvdRegister[];
}

export interface SvdDevice {
    name: string;
    peripherals: SvdPeripheral[];
}

// ── Cached parse result ─────────────────────────────────────────

let cachedDevice: SvdDevice | null = null;
let cachedSvdPath: string | null = null;

export function clearSvdCache(): void {
    cachedDevice = null;
    cachedSvdPath = null;
}

// ── SVD file finder ─────────────────────────────────────────────

/**
 * Locate the SVD file for the current debug session.
 * Strategy order:
 *   1. session.configuration.svdFile (user-explicit)
 *   2. Parse cbuild-run.yml from the session's cwd, match pname from session name
 *   3. Search workspace for *.svd files
 */
export async function findSvdFile(): Promise<string | null> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return null; }
    const config = session.configuration;

    // 1. Explicit svdFile in launch config
    if (config.svdFile) {
        const resolved = resolvePackRoot(config.svdFile);
        if (fs.existsSync(resolved)) { return resolved; }
    }

    // 2. Try cbuild-run.yml
    const cbuildRunFile = config.cmsis?.cbuildRunFile;
    if (cbuildRunFile) {
        const svd = await findSvdFromCbuildRun(cbuildRunFile, session.name);
        if (svd) { return svd; }
    }

    // 2b. Search for cbuild-run.yml in the cwd
    const cwd = config.cwd;
    if (cwd) {
        const outDir = path.join(cwd, 'out');
        if (fs.existsSync(outDir)) {
            const files = fs.readdirSync(outDir).filter(f => f.endsWith('.cbuild-run.yml'));
            for (const f of files) {
                const svd = await findSvdFromCbuildRunPath(path.join(outDir, f), session.name);
                if (svd) { return svd; }
            }
        }
    }

    // 3. Search workspace for .svd files
    const svdFiles = await vscode.workspace.findFiles('**/*.svd', '**/node_modules/**', 5);
    if (svdFiles.length === 1) { return svdFiles[0].fsPath; }

    return null;
}

async function findSvdFromCbuildRun(cbuildRunRef: string, sessionName: string): Promise<string | null> {
    // cbuildRunFile may be a ${command:...} reference — try to resolve it
    if (cbuildRunRef.startsWith('${command:')) {
        // Can't call commands directly, try to find .cbuild-run.yml in workspace
        const files = await vscode.workspace.findFiles('**/*.cbuild-run.yml', '**/node_modules/**', 5);
        for (const f of files) {
            const result = await findSvdFromCbuildRunPath(f.fsPath, sessionName);
            if (result) { return result; }
        }
        return null;
    }
    return findSvdFromCbuildRunPath(cbuildRunRef, sessionName);
}

async function findSvdFromCbuildRunPath(filePath: string, sessionName: string): Promise<string | null> {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Extract SVD entries: "- file: ... type: svd pname: ..."
        const svdEntries: { file: string; pname?: string }[] = [];
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const fileLine = lines[i].match(/^\s*-\s*file:\s*(.+)$/);
            if (fileLine) {
                const entry: { file: string; pname?: string } = { file: fileLine[1].trim() };
                // Look at next few lines for type and pname
                for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                    const typeLine = lines[j].match(/^\s+type:\s*(.+)$/);
                    if (typeLine && typeLine[1].trim() !== 'svd') { break; }
                    const pnameLine = lines[j].match(/^\s+pname:\s*(.+)$/);
                    if (pnameLine) { entry.pname = pnameLine[1].trim(); }
                    if (lines[j].match(/^\s*-\s/)) { break; } // next entry
                }
                // Only include SVD entries
                const isType = lines.slice(i + 1, i + 4).some(l => l.match(/^\s+type:\s*svd/));
                if (isType) { svdEntries.push(entry); }
            }
        }

        // Match by pname from session name (e.g. "M55_HP" in "M55_HP CMSIS_DAP@pyOCD (launch)")
        const pnameMatch = sessionName.match(/M55_H[PE]/i)?.[0]?.toUpperCase();
        for (const entry of svdEntries) {
            if (pnameMatch && entry.pname?.toUpperCase().includes(pnameMatch)) {
                const resolved = resolvePackRoot(entry.file);
                if (fs.existsSync(resolved)) { return resolved; }
            }
        }

        // If no pname match, return first SVD
        if (svdEntries.length > 0) {
            const resolved = resolvePackRoot(svdEntries[0].file);
            if (fs.existsSync(resolved)) { return resolved; }
        }
    } catch {
        // File not readable
    }
    return null;
}

function resolvePackRoot(filePath: string): string {
    if (filePath.includes('${CMSIS_PACK_ROOT}')) {
        const packRoot = process.env.CMSIS_PACK_ROOT
            || path.join(os.homedir(), '.cache', 'arm', 'packs');
        return filePath.replace('${CMSIS_PACK_ROOT}', packRoot);
    }
    return filePath;
}

// ── SVD parser ──────────────────────────────────────────────────

/**
 * Load and parse SVD. Returns cached result if same path.
 */
export async function loadSvd(): Promise<SvdDevice | null> {
    const svdPath = await findSvdFile();
    if (!svdPath) { return null; }

    if (cachedDevice && cachedSvdPath === svdPath) {
        return cachedDevice;
    }

    try {
        const xml = fs.readFileSync(svdPath, 'utf-8');
        cachedDevice = parseSvdXml(xml);
        cachedSvdPath = svdPath;
        return cachedDevice;
    } catch {
        return null;
    }
}

// ── XML text helpers (no external dependency) ───────────────────

function extractTag(xml: string, tag: string): string | null {
    const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);
    const m = xml.match(re);
    return m ? m[1].trim() : null;
}

function extractBlocks(xml: string, tag: string): string[] {
    const blocks: string[] = [];
    const open = `<${tag}`;
    const close = `</${tag}>`;
    let pos = 0;
    while (pos < xml.length) {
        const start = xml.indexOf(open, pos);
        if (start === -1) { break; }
        const end = xml.indexOf(close, start);
        if (end === -1) { break; }
        blocks.push(xml.substring(start, end + close.length));
        pos = end + close.length;
    }
    return blocks;
}

function extractAttr(xml: string, attr: string): string | null {
    const re = new RegExp(`${attr}="([^"]+)"`);
    const m = xml.match(re);
    return m ? m[1] : null;
}

function parseHex(s: string): number {
    s = s.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) { return parseInt(s, 16); }
    return parseInt(s, 10);
}

// ── Core parsing ────────────────────────────────────────────────

function parseSvdXml(xml: string): SvdDevice {
    const deviceName = extractTag(xml, 'name') || 'unknown';
    const peripheralBlocks = extractBlocks(xml, 'peripheral');

    // First pass: build map of all peripherals (needed for derivedFrom)
    const peripheralMap = new Map<string, SvdPeripheral>();
    const orderedPeripherals: SvdPeripheral[] = [];

    for (const pBlock of peripheralBlocks) {
        const name = extractTag(pBlock, 'name');
        if (!name) { continue; }

        const baseAddrStr = extractTag(pBlock, 'baseAddress');
        const baseAddress = baseAddrStr ? parseHex(baseAddrStr) : 0;
        const description = extractTag(pBlock, 'description') || undefined;

        // Check derivedFrom attribute
        const derivedFrom = extractAttr(pBlock.substring(0, pBlock.indexOf('>')), 'derivedFrom');

        let registers: SvdRegister[] = [];

        // Parse own registers
        const regBlocks = extractBlocks(pBlock, 'register');
        if (regBlocks.length > 0) {
            registers = regBlocks.map(parseSvdRegister);
        } else if (derivedFrom) {
            // Inherit registers from parent peripheral
            const parent = peripheralMap.get(derivedFrom);
            if (parent) {
                registers = parent.registers; // shared reference is fine (read-only)
            }
        }

        const peripheral: SvdPeripheral = { name, baseAddress, description, registers };
        peripheralMap.set(name, peripheral);
        orderedPeripherals.push(peripheral);
    }

    return { name: deviceName, peripherals: orderedPeripherals };
}

function parseSvdRegister(regXml: string): SvdRegister {
    const name = extractTag(regXml, 'name') || 'unknown';
    const offsetStr = extractTag(regXml, 'addressOffset');
    const addressOffset = offsetStr ? parseHex(offsetStr) : 0;
    const sizeStr = extractTag(regXml, 'size');
    const size = sizeStr ? parseHex(sizeStr) : 32;
    const description = extractTag(regXml, 'description') || undefined;
    const access = extractTag(regXml, 'access') || undefined;
    const resetStr = extractTag(regXml, 'resetValue');
    const resetValue = resetStr ? parseHex(resetStr) : undefined;

    const fieldBlocks = extractBlocks(regXml, 'field');
    const fields = fieldBlocks.map(parseSvdField);

    return { name, addressOffset, size, description, access, resetValue, fields };
}

function parseSvdField(fieldXml: string): SvdField {
    const name = extractTag(fieldXml, 'name') || 'unknown';
    const description = extractTag(fieldXml, 'description') || undefined;
    const access = extractTag(fieldXml, 'access') || undefined;

    // Parse bitRange "[hi:lo]" or bitOffset+bitWidth
    let bitHigh = 0;
    let bitLow = 0;
    const bitRange = extractTag(fieldXml, 'bitRange');
    if (bitRange) {
        const m = bitRange.match(/\[(\d+):(\d+)\]/);
        if (m) {
            bitHigh = parseInt(m[1], 10);
            bitLow = parseInt(m[2], 10);
        }
    } else {
        const offsetStr = extractTag(fieldXml, 'bitOffset');
        const widthStr = extractTag(fieldXml, 'bitWidth');
        bitLow = offsetStr ? parseInt(offsetStr, 10) : 0;
        const width = widthStr ? parseInt(widthStr, 10) : 1;
        bitHigh = bitLow + width - 1;
    }

    return { name, bitHigh, bitLow, description, access };
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
