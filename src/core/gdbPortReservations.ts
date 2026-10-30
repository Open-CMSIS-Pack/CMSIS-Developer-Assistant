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
 * Cross-process reservations bridge the gap between the GDB port preflight
 * and the session/task publishing its port. A fully written, nonempty
 * directory is renamed into place atomically; two windows cannot both own
 * it. No TCP connection is made and the real server can bind normally.
 *
 * There is no time-based expiry: a slow flash or picker can outlive a tool
 * deadline. Once a session/task claims the port, its end releases the
 * reservation; a session claims it when its adapter starts (`adoptPort`),
 * whatever the tool call saw. A confirmed start failure releases it too.
 * Shutdown releases this window's claims, and a later contender can reclaim
 * a dead process's claim. Unknown/malformed owners fail closed rather than
 * risk a target.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { gdbPortRefusal, type PortStart } from './gdbPortGuard';
import type { GdbPortClaim } from './gdbServerPorts';
import { ToolError } from './toolResult';
import { defaultRegistryDir, ensureRegistryDir, isProcessAlive } from '../utils/workspaceRegistry';
import { logger } from '../utils/logger';

/** A reservation stays held until its confirmed failure or owning session/task ends. */
export interface GdbPortReservation {
    /** A verified session/run owns this batch, even when a periodic port sample missed its start. */
    adopt(): void;
    /** Idempotent; can remove only this reservation's unique owner record. */
    release(): void;
}

interface ReservationOwner {
    pid: number;
    name: string;
    label: string;
}

interface HeldReservation extends GdbPortReservation {
    port: number;
    directory: string;
    ownerFile: string;
    group: string;
    generation: number;
    adopted: boolean;
}

/** A filesystem error code without assuming a thrown value is an Error. */
function codeOf(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Remove only the named owner, then its empty directory, never another owner's replacement. */
function removeOwner(directory: string, ownerFile: string): void {
    try {
        fs.unlinkSync(path.join(directory, ownerFile));
    } catch (caught) {
        if (codeOf(caught) === 'ENOENT') {
            return;
        }
        throw caught;
    }
    try {
        fs.rmdirSync(directory);
    } catch (caught) {
        // A contender may have atomically replaced the now-empty directory
        // with its own nonempty one. Never remove that new owner's record.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(caught) ?? '')) {
            throw caught;
        }
    }
}

/** No filesystem writes until acquire; injectable identity/directory keep tests isolated. */
export class GdbPortReservations {
    private readonly held = new Set<HeldReservation>();
    private generation = 0;
    private readonly directory: string;
    private readonly registryRoot: string | undefined;

    constructor(
        directory?: string,
        private readonly pid: number = process.pid,
        private readonly alive: (pid: number) => boolean = isProcessAlive,
        registryRoot?: string,
    ) {
        this.registryRoot = registryRoot ?? (directory === undefined ? defaultRegistryDir() : undefined);
        this.directory = directory ?? path.join(this.registryRoot as string, 'gdb-port-reservations');
    }

    /** Reserve before any asynchronous preflight or launch. A live contender is PROBE_BUSY. */
    acquire(port: number, start: PortStart, name: string, group: string = randomUUID()): GdbPortReservation {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new ToolError('INVALID_ARGUMENT', `Invalid GDB port ${port}.`);
        }
        const target = path.join(this.directory, `port-${port}`);
        const ownerFile = `owner-${randomUUID()}.json`;
        let staging: string | undefined;
        try {
            if (this.registryRoot) {
                const rootUnfit = ensureRegistryDir(this.registryRoot, { platform: process.platform, uid: process.getuid?.() });
                if (rootUnfit) {
                    throw new Error(`${this.registryRoot} ${rootUnfit}`);
                }
            }
            const unfit = ensureRegistryDir(this.directory, { platform: process.platform, uid: process.getuid?.() });
            if (unfit) {
                throw new Error(`${this.directory} ${unfit}`);
            }
            staging = fs.mkdtempSync(path.join(this.directory, `.port-${port}-`));
            const prepared = staging;
            const owner: ReservationOwner = { pid: this.pid, name, label: start.configuration ?? start.subject };
            fs.writeFileSync(path.join(staging, ownerFile), JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
            // Bounded retries cover a release/reclaim racing this acquire.
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    fs.renameSync(prepared, target);
                    staging = undefined;
                    return this.remember(port, target, ownerFile, group);
                } catch (caught) {
                    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(codeOf(caught) ?? '')) {
                        throw caught;
                    }
                }
                let names: string[];
                try {
                    const stats = fs.lstatSync(target);
                    if (!stats.isDirectory() || stats.isSymbolicLink()) {
                        throw new Error(`${target} is not a reservation directory`);
                    }
                    names = fs.readdirSync(target);
                } catch (caught) {
                    if (codeOf(caught) === 'ENOENT') {
                        continue;
                    }
                    throw caught;
                }
                if (names.length === 0) {
                    // Windows will not rename over the empty directory a
                    // releaser left; removing only an empty directory is safe.
                    try {
                        fs.rmdirSync(target);
                    } catch (caught) {
                        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(caught) ?? '')) {
                            throw caught;
                        }
                    }
                    continue;
                }
                if (names.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(names[0])) {
                    throw new Error(`${target} has an unrecognised owner record`);
                }
                let other: ReservationOwner;
                try {
                    const file = path.join(target, names[0]);
                    const stats = fs.lstatSync(file);
                    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16384) {
                        throw new Error(`${file} is not a valid owner record`);
                    }
                    other = JSON.parse(fs.readFileSync(file, 'utf8')) as ReservationOwner;
                } catch (caught) {
                    if (codeOf(caught) === 'ENOENT') {
                        continue;
                    }
                    throw caught;
                }
                if (!Number.isInteger(other.pid) || other.pid <= 0 || typeof other.name !== 'string' || typeof other.label !== 'string') {
                    throw new Error(`${target} has an invalid owner record`);
                }
                if (this.alive(other.pid)) {
                    throw gdbPortRefusal(start, port, { kind: 'reservation', pid: other.pid, name: other.name, label: other.label });
                }
                // Only the reaper that removed this unique dead owner's file
                // may remove the directory. Another reaper cannot erase a new claim.
                removeOwner(target, names[0]);
            }
            throw new Error(`GDB port ${port} reservation changed repeatedly; retry after the other start settles`);
        } catch (caught) {
            if (caught instanceof ToolError) {
                throw caught;
            }
            throw new ToolError('INTERNAL', `GDB port ${port} was not reserved; no launch was started: ${caught instanceof Error ? caught.message : String(caught)}.`);
        } finally {
            if (staging) {
                try {
                    removeOwner(staging, ownerFile);
                } catch (caught) {
                    logger.warn(`Could not remove GDB reservation staging record ${staging}`, caught);
                }
            }
        }
    }

    /** Capture before an asynchronous query so its old state cannot adopt a newer pending start. */
    observationVersion(): number {
        return this.generation;
    }

    /**
     * A debug session of this window begins on `port`: its batch is owned
     * from now on, so the end of the session releases it however long the
     * tool call waited and whether or not a port sample saw it live. VS Code
     * announces a session only once its launch succeeded; a failed one ends
     * unannounced.
     */
    adoptPort(port: number): void {
        for (const reservation of this.held) {
            if (reservation.port === port) {
                reservation.adopt();
            }
        }
    }

    /** Keep pending starts; once adopted, release only when the session/task no longer claims the port. */
    observe(claims: readonly GdbPortClaim[], version: number = this.generation): void {
        const eligible = [...this.held].filter((reservation) => reservation.generation <= version);
        const ports = new Set(claims.map((claim) => claim.port));
        const activeGroups = new Set(eligible.filter((reservation) => ports.has(reservation.port)).map((reservation) => reservation.group));
        for (const reservation of eligible) {
            // Several alternative configurations can be offered by one
            // launch. Their batch ends together, including unselected ports.
            if (activeGroups.has(reservation.group)) {
                reservation.adopted = true;
            } else if (reservation.adopted) {
                reservation.release();
            }
        }
    }

    /** Normal window shutdown: release only records created by this manager. */
    dispose(): void {
        for (const reservation of [...this.held]) {
            reservation.release();
        }
    }

    private remember(port: number, directory: string, ownerFile: string, group: string): GdbPortReservation {
        const reservation: HeldReservation = {
            port, directory, ownerFile, group, generation: ++this.generation, adopted: false,
            adopt: () => {
                if (!this.held.has(reservation)) {
                    return;
                }
                const generation = ++this.generation;
                for (const held of this.held) {
                    if (held.group === group) {
                        held.adopted = true;
                        held.generation = generation;
                    }
                }
            },
            release: () => {
                if (this.held.has(reservation)) {
                    try {
                        removeOwner(directory, ownerFile);
                        this.held.delete(reservation);
                    } catch (caught) {
                        // A failed cleanup must neither mask the launch error
                        // nor prevent other window resources from closing.
                        logger.warn(`Could not release GDB port ${port} reservation`, caught);
                    }
                }
            },
        };
        this.held.add(reservation);
        return reservation;
    }
}
