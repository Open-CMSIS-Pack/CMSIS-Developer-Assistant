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
 * The core knowledge index the extension ships, `resources/knowledge/core.db`,
 * is git-ignored and pinned by `resources/knowledge/core.lock.json`: the
 * version, the URL and the sha256 of one release of the knowledge-base
 * repository (`core-<version>`, published by its `scripts/release_core.sh`).
 * The same release carries `SOURCES.md`, the attribution of the index's
 * content (every source with its licence, the copyright lines and licence
 * texts the licences require); the lock names it (`sources`, `sourcesSha256`)
 * and the committed copy `resources/knowledge/SOURCES.md` must match it.
 * This module reads and validates the lock, tells whether the local index is
 * the pinned one, downloads the pinned file (redirects followed, hash and size
 * checked before the file takes its place) and rewrites the lock from a
 * release's metadata. Build tooling, not extension code: scripts/knowledge-index.ts
 * is the command line over it, scripts/package.ts refuses a VSIX without the
 * pinned index through `assertPinnedIndex()`, and src/test/knowledgeIndexLock.test.ts
 * tests it without a network. It lives under src/ because the scripts are an
 * ES module package and the compiled tests are CommonJS; nothing of the
 * extension imports it, so the bundle does not carry it. No `vscode` import.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';

/** The lock, relative to the repository root. */
export const LOCK_RELATIVE = path.join('resources', 'knowledge', 'core.lock.json');

/** The index, relative to the repository root. */
export const INDEX_RELATIVE = path.join('resources', 'knowledge', 'core.db');

/** The attribution of the index's content, relative to the repository root; committed, unlike the index. */
export const SOURCES_RELATIVE = path.join('resources', 'knowledge', 'SOURCES.md');

/** The command that makes the local index the pinned one; named in every refusal. */
export const FETCH_COMMAND = 'npm run knowledge:fetch';

/** One pinned release of the core index. */
export interface CoreIndexLock {
    /** The release's version, a date such as `2026.10.21`; the tag is `core-<version>`. */
    version: string;
    /** The release asset to download. */
    url: string;
    /** Lower-case hex sha256 of the asset. */
    sha256: string;
    /** Size of the asset in bytes. */
    size: number;
    /** Knowledge units in the index, as the release's metadata counts them. */
    units: number;
    /** The knowledge-base commit the index was built from. */
    kbCommit: string;
    /** The release's `SOURCES.md`, when the release has one. */
    sources?: string;
    /** Lower-case hex sha256 of that file; present whenever `sources` is. */
    sourcesSha256?: string;
}

/** What `knowledge-core-<version>.json` of a release holds: the index's `info` table plus the file's name, hash and size. */
export interface ReleaseRecord {
    file: string;
    sha256: string;
    size: number;
    units: number;
    kbCommit: string;
    /** The name and sha256 of the release's `SOURCES.md` (`sources`, `sources_sha256`), when the release has one. */
    sources?: string;
    sourcesSha256?: string;
}

/** The committed SOURCES.md compared with the lock. */
export type SourcesState =
    | { kind: 'none' }
    | { kind: 'missing' }
    | { kind: 'pinned'; sha256: string }
    | { kind: 'unpinned'; sha256: string };

/** The local index compared with the lock. */
export type IndexState =
    | { kind: 'missing' }
    | { kind: 'pinned'; sha256: string; size: number }
    | { kind: 'unpinned'; sha256: string; size: number };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_REDIRECTS = 10;

function field(record: Record<string, unknown>, name: string, origin: string): unknown {
    if (!(name in record)) {
        throw new Error(`${origin}: missing field "${name}"`);
    }
    return record[name];
}

function stringField(record: Record<string, unknown>, name: string, origin: string): string {
    const value = field(record, name, origin);
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${origin}: "${name}" must be a non-empty string`);
    }
    return value;
}

function countField(record: Record<string, unknown>, name: string, origin: string): number {
    const value = field(record, name, origin);
    const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
        throw new Error(`${origin}: "${name}" must be a positive integer`);
    }
    return count;
}

function hashField(record: Record<string, unknown>, name: string, origin: string): string {
    const value = stringField(record, name, origin).toLowerCase();
    if (!SHA256_HEX.test(value)) {
        throw new Error(`${origin}: "${name}" must be 64 hex digits of sha256`);
    }
    return value;
}

function asRecord(text: string, origin: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`${origin}: not JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${origin}: expected a JSON object`);
    }
    return parsed as Record<string, unknown>;
}

/** Parses and validates a lock file's text; `origin` names it in errors. */
export function parseLock(text: string, origin: string = LOCK_RELATIVE): CoreIndexLock {
    const record = asRecord(text, origin);
    const url = stringField(record, 'url', origin);
    if (!/^https:\/\//.test(url)) {
        throw new Error(`${origin}: "url" must be an https URL`);
    }
    const lock: CoreIndexLock = {
        version: stringField(record, 'version', origin),
        url,
        sha256: hashField(record, 'sha256', origin),
        size: countField(record, 'size', origin),
        units: countField(record, 'units', origin),
        kbCommit: stringField(record, 'kbCommit', origin),
    };
    if ('sources' in record) {
        lock.sources = stringField(record, 'sources', origin);
        if (!/^https:\/\//.test(lock.sources)) {
            throw new Error(`${origin}: "sources" must be an https URL`);
        }
        lock.sourcesSha256 = hashField(record, 'sourcesSha256', origin);
    }
    return lock;
}

/** Reads the lock of a repository. */
export function readLock(repoRoot: string): CoreIndexLock {
    const file = path.join(repoRoot, LOCK_RELATIVE);
    return parseLock(fs.readFileSync(file, 'utf8'), path.relative(repoRoot, file));
}

/** Writes the lock of a repository, two-space JSON with a final newline. */
export function writeLock(repoRoot: string, lock: CoreIndexLock): void {
    fs.writeFileSync(path.join(repoRoot, LOCK_RELATIVE), `${JSON.stringify(lock, null, 2)}\n`);
}

/** Parses and validates a release's `knowledge-core-<version>.json`. */
export function parseReleaseRecord(text: string, origin: string): ReleaseRecord {
    const record = asRecord(text, origin);
    const release: ReleaseRecord = {
        file: stringField(record, 'file', origin),
        sha256: hashField(record, 'sha256', origin),
        size: countField(record, 'size', origin),
        units: countField(record, 'units', origin),
        kbCommit: stringField(record, 'kb_commit', origin),
    };
    if ('sources' in record) {
        release.sources = stringField(record, 'sources', origin);
        release.sourcesSha256 = hashField(record, 'sources_sha256', origin);
    }
    return release;
}

/** The releases folder of the knowledge base, from the URL of the lock: `…/releases/download`. */
export function releasesBase(lockUrl: string): string {
    const match = /^(.*\/releases\/download)\/core-[^/]+\/[^/]+$/.exec(lockUrl);
    if (!match) {
        throw new Error(`the lock's URL does not point into a release's assets: ${lockUrl}`);
    }
    return match[1];
}

/** The URL of a release's metadata file. */
export function releaseRecordUrl(lockUrl: string, version: string): string {
    return `${releasesBase(lockUrl)}/core-${version}/knowledge-core-${version}.json`;
}

/** The lock that pins a release, from its metadata. */
export function lockFromRelease(lockUrl: string, version: string, record: ReleaseRecord): CoreIndexLock {
    const lock: CoreIndexLock = {
        version,
        url: `${releasesBase(lockUrl)}/core-${version}/${record.file}`,
        sha256: record.sha256,
        size: record.size,
        units: record.units,
        kbCommit: record.kbCommit,
    };
    if (record.sources && record.sourcesSha256) {
        lock.sources = `${releasesBase(lockUrl)}/core-${version}/${record.sources}`;
        lock.sourcesSha256 = record.sourcesSha256;
    }
    return lock;
}

/** The sha256 of a file, lower-case hex. Synchronous: the index is read once, which takes well under a second. */
export function sha256OfFile(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Compares the local index with the lock. */
export function indexState(repoRoot: string, lock: CoreIndexLock): IndexState {
    const file = path.join(repoRoot, INDEX_RELATIVE);
    if (!fs.existsSync(file)) {
        return { kind: 'missing' };
    }
    const size = fs.statSync(file).size;
    const sha256 = sha256OfFile(file);
    return { kind: sha256 === lock.sha256 && size === lock.size ? 'pinned' : 'unpinned', sha256, size };
}

/** Compares the committed SOURCES.md with the lock; `none` when the lock names no such file. */
export function sourcesState(repoRoot: string, lock: CoreIndexLock): SourcesState {
    if (!lock.sources || !lock.sourcesSha256) {
        return { kind: 'none' };
    }
    const file = path.join(repoRoot, SOURCES_RELATIVE);
    if (!fs.existsSync(file)) {
        return { kind: 'missing' };
    }
    const sha256 = sha256OfFile(file);
    return { kind: sha256 === lock.sourcesSha256 ? 'pinned' : 'unpinned', sha256 };
}

/** What the packaging gate decided. */
export interface PinnedIndexOptions {
    /** `--index-unpinned`: a present index that is not the pinned one passes, with a warning. */
    allowUnpinned: boolean;
    /** Where the warning goes; `console.warn` when not set. */
    warn?: (message: string) => void;
}

/**
 * The packaging gate: the local index must be the pinned one, and the committed
 * SOURCES.md the one of the same release when the lock names it. A missing index
 * is refused in every case; a different index or attribution only without
 * `allowUnpinned`. Returns the lock and both states for the caller's message.
 */
export function assertPinnedIndex(repoRoot: string, options: PinnedIndexOptions): { lock: CoreIndexLock; state: IndexState; sources: SourcesState } {
    const lock = readLock(repoRoot);
    const state = indexState(repoRoot, lock);
    const warn = options.warn ?? ((message: string): void => { console.warn(message); });
    if (state.kind === 'missing') {
        throw new Error(`The core knowledge index ${INDEX_RELATIVE} is missing; a VSIX without it is not packaged. `
            + `Run \`${FETCH_COMMAND}\` to download the pinned index ${lock.version} (sha256 ${lock.sha256}).`);
    }
    if (state.kind === 'unpinned') {
        const detail = `${INDEX_RELATIVE} has sha256 ${state.sha256} (${state.size} bytes), the lock pins ${lock.version} `
            + `with sha256 ${lock.sha256} (${lock.size} bytes)`;
        if (!options.allowUnpinned) {
            throw new Error(`The core knowledge index is not the pinned one: ${detail}. `
                + `Run \`${FETCH_COMMAND}\` to replace it, or pass --index-unpinned to package this index anyway (never for a release).`);
        }
        warn('\n' + '!'.repeat(78) + `\n!! WARNING: packaging an UNPINNED core knowledge index (--index-unpinned).\n!! ${detail}.\n`
            + `!! This VSIX is not reproducible from the lock; never publish it.\n` + '!'.repeat(78) + '\n');
    }
    const sources = sourcesState(repoRoot, lock);
    if (sources.kind === 'missing' || sources.kind === 'unpinned') {
        const detail = sources.kind === 'missing' ? `${SOURCES_RELATIVE} is missing`
            : `${SOURCES_RELATIVE} has sha256 ${sources.sha256}, the lock pins ${lock.sourcesSha256}`;
        if (!options.allowUnpinned) {
            throw new Error(`The attribution of the core knowledge index is not the pinned one: ${detail}. `
                + `Run \`${FETCH_COMMAND}\` to download the release's SOURCES.md and commit it.`);
        }
        warn(`WARNING: ${detail}; the VSIX ships an attribution that may not match its index.`);
    }
    return { lock, state, sources };
}

/** One HTTP(S) GET with redirects followed, resolved with the final response. */
export function httpGet(url: string, redirectsLeft: number = MAX_REDIRECTS): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const client = target.protocol === 'https:' ? https : http;
        const request = client.get(target, { headers: { 'user-agent': 'cmsis-developer-assistant-knowledge-index' } }, (response) => {
            const status = response.statusCode ?? 0;
            const location = response.headers.location;
            if (status >= 300 && status < 400 && location) {
                response.resume();
                if (redirectsLeft === 0) {
                    reject(new Error(`too many redirects fetching ${url}`));
                    return;
                }
                httpGet(new URL(location, target).toString(), redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                response.resume();
                reject(new Error(`GET ${url} answered ${status}${response.statusMessage ? ` ${response.statusMessage}` : ''}`));
                return;
            }
            resolve(response);
        });
        request.on('error', reject);
    });
}

/** The body of a small file, as text. */
export async function fetchText(url: string): Promise<string> {
    const response = await httpGet(url);
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Downloads `url` into `destination`: streamed into a temporary file beside
 * it while the hash is computed, renamed into place only when hash and size
 * match `expected`, deleted otherwise.
 */
export async function downloadVerified(url: string, destination: string, expected: { sha256: string; size?: number }): Promise<void> {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const partial = `${destination}.${process.pid}.part`;
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
        const response = await httpGet(url);
        await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(partial);
            response.on('data', (chunk: Buffer) => { hash.update(chunk); size += chunk.length; });
            response.on('error', reject);
            out.on('error', reject);
            // 'close', not 'finish': on Windows a file whose handle is still open
            // cannot be renamed, and a deleted one stays listed until it closes.
            out.on('close', resolve);
            response.pipe(out);
        });
        const sha256 = hash.digest('hex');
        if (sha256 !== expected.sha256 || (expected.size !== undefined && size !== expected.size)) {
            throw new Error(`the download of ${url} does not match the lock: sha256 ${sha256} (${size} bytes), `
                + `expected ${expected.sha256}${expected.size !== undefined ? ` (${expected.size} bytes)` : ''}; the file was discarded`);
        }
        fs.renameSync(partial, destination);
    } finally {
        fs.rmSync(partial, { force: true });
    }
}

/** Makes the local index the pinned one; says what it did. */
export async function fetchIndex(repoRoot: string, lock: CoreIndexLock): Promise<'kept' | 'downloaded' | 'replaced'> {
    const state = indexState(repoRoot, lock);
    if (state.kind === 'pinned') {
        return 'kept';
    }
    await downloadVerified(lock.url, path.join(repoRoot, INDEX_RELATIVE), lock);
    return state.kind === 'missing' ? 'downloaded' : 'replaced';
}

/** Makes the committed SOURCES.md the release's; `none` when the lock names no such file. */
export async function fetchSources(repoRoot: string, lock: CoreIndexLock): Promise<'none' | 'kept' | 'downloaded' | 'replaced'> {
    const state = sourcesState(repoRoot, lock);
    if (state.kind === 'none') {
        return 'none';
    }
    if (state.kind === 'pinned') {
        return 'kept';
    }
    await downloadVerified(lock.sources as string, path.join(repoRoot, SOURCES_RELATIVE), { sha256: lock.sourcesSha256 as string });
    return state.kind === 'missing' ? 'downloaded' : 'replaced';
}
