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

/** Obtain only the supported read-only CMSIS Solution API in this VS Code window.
 * Activation is lazy, bounded by the resolver's deadline, and does not require an
 * active solution or debug session. No direct Solar requests or internal files. */
import * as vscode from 'vscode';
import { discoverDevice } from './core/deviceDiscovery';
import type { DiscoveryApi, DiscoveryRequest } from './core/deviceDiscovery';

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Check public capabilities rather than assuming an installed version has v2. */
export async function loadDiscoveryApi(): Promise<DiscoveryApi> {
    const extension = vscode.extensions.getExtension<unknown>('Arm.cmsis-csolution');
    if (!extension) { throw new Error('CMSIS Solution is not installed in this window.'); }
    const exports = await extension.activate();
    if (!record(exports) || typeof exports.getApi !== 'function') { throw new Error('CMSIS Solution does not expose getApi.'); }
    const api: unknown = exports.getApi(2);
    if (!record(api) || typeof api.getBoards !== 'function' || typeof api.getDevices !== 'function') {
        throw new Error('CMSIS Solution API v2 has no board/device catalog capability.');
    }
    return api as unknown as DiscoveryApi;
}

/** Compact JSON retains exact identifiers and explicit uncertainty for agents. */
export async function runDeviceDiscovery(request: DiscoveryRequest): Promise<string> {
    return JSON.stringify(await discoverDevice(loadDiscoveryApi, request));
}
