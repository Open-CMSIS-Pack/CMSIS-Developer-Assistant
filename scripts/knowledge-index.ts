#!npx tsx

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
 * The core knowledge index on the command line, over src/core/knowledge/coreIndexLock.ts:
 *
 *   npm run knowledge:fetch               download the pinned index into resources/knowledge/core.db
 *                                         when it is missing or differs from the lock; hash and size checked;
 *                                         the same for the release's SOURCES.md (committed) when the lock names it
 *   npm run knowledge:check               verify only; exit 1 when the index or SOURCES.md is missing or not the pinned one
 *   npm run knowledge:update -- <version> pin the release core-<version> of the knowledge base: reads its
 *                                         knowledge-core-<version>.json and rewrites resources/knowledge/core.lock.json
 *
 * The CI package job runs `fetch` before `npm run package`, which runs `check` itself.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

import {
    CoreIndexLock, FETCH_COMMAND, INDEX_RELATIVE, LOCK_RELATIVE, SOURCES_RELATIVE, fetchIndex, fetchSources, fetchText, indexState,
    lockFromRelease, parseReleaseRecord, readLock, releaseRecordUrl, sourcesState, writeLock,
} from '../src/core/knowledge/coreIndexLock';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function describe(lock: CoreIndexLock): string {
    return `${lock.version} (${lock.units} units, sha256 ${lock.sha256}, ${lock.size} bytes, knowledge base ${lock.kbCommit.slice(0, 7)})`;
}

async function fetch(): Promise<number> {
    const lock = readLock(repoRoot);
    const result = await fetchIndex(repoRoot, lock);
    const verb = result === 'kept' ? 'is already' : result === 'downloaded' ? 'downloaded:' : 'replaced by';
    console.log(`${INDEX_RELATIVE} ${verb} the pinned core index ${describe(lock)}`);
    const sources = await fetchSources(repoRoot, lock);
    if (sources === 'none') {
        console.log(`the lock names no SOURCES.md; ${SOURCES_RELATIVE} is left as committed`);
    } else {
        const did = sources === 'kept' ? 'is already' : sources === 'downloaded' ? 'downloaded:' : 'replaced by';
        console.log(`${SOURCES_RELATIVE} ${did} the release's SOURCES.md (sha256 ${lock.sourcesSha256})${sources === 'kept' ? '' : '; commit it'}`);
    }
    return 0;
}

function check(): number {
    const lock = readLock(repoRoot);
    const state = indexState(repoRoot, lock);
    let code = 0;
    if (state.kind === 'pinned') {
        console.log(`${INDEX_RELATIVE} is the pinned core index ${describe(lock)}`);
    } else {
        const found = state.kind === 'missing' ? 'is missing' : `has sha256 ${state.sha256} (${state.size} bytes)`;
        console.error(`${INDEX_RELATIVE} ${found}; the lock pins ${describe(lock)}. Run \`${FETCH_COMMAND}\`.`);
        code = 1;
    }
    const sources = sourcesState(repoRoot, lock);
    if (sources.kind === 'none' || sources.kind === 'pinned') {
        console.log(sources.kind === 'none' ? 'the lock names no SOURCES.md' : `${SOURCES_RELATIVE} is the release's SOURCES.md (sha256 ${lock.sourcesSha256})`);
    } else {
        const found = sources.kind === 'missing' ? 'is missing' : `has sha256 ${sources.sha256}`;
        console.error(`${SOURCES_RELATIVE} ${found}; the lock pins sha256 ${lock.sourcesSha256}. Run \`${FETCH_COMMAND}\` and commit the file.`);
        code = 1;
    }
    return code;
}

async function update(version: string | undefined): Promise<number> {
    if (!version || !/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(version)) {
        console.error('usage: npm run knowledge:update -- <version>    (the date of the release, e.g. 2026.10.21)');
        return 2;
    }
    const current = readLock(repoRoot);
    const url = releaseRecordUrl(current.url, version);
    console.log(`Reading ${url}`);
    const record = parseReleaseRecord(await fetchText(url), url);
    const next = lockFromRelease(current.url, version, record);
    writeLock(repoRoot, next);
    const changed = (Object.keys(next) as (keyof CoreIndexLock)[]).filter((key) => next[key] !== current[key]);
    console.log(`${LOCK_RELATIVE} pins ${describe(next)}; changed: ${changed.length > 0 ? changed.join(', ') : 'nothing'}.`);
    if (next.sha256 !== current.sha256) {
        console.log(`Run \`${FETCH_COMMAND}\` to download it.`);
    }
    return 0;
}

async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    switch (command) {
        case 'fetch': return fetch();
        case 'check': return check();
        case 'update': return update(rest[0]);
        default:
            console.error('usage: tsx scripts/knowledge-index.ts fetch | check | update <version>');
            return 2;
    }
}

main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    },
);
