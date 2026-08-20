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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parse as parseSemver } from 'semver';

const argv = process.argv.slice(2);

function getOptionValue(args: string[], longName: string, shortName: string): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];

        if (arg === longName || arg === shortName) {
            const nextValue = args[index + 1];
            if (!nextValue || nextValue.startsWith('-')) {
                return undefined;
            }

            return nextValue;
        }

        if (arg.startsWith(`${longName}=`)) {
            const value = arg.slice(`${longName}=`.length).trim();
            return value.length > 0 ? value : undefined;
        }

        if (arg.startsWith(`${shortName}=`)) {
            const value = arg.slice(`${shortName}=`.length).trim();
            return value.length > 0 ? value : undefined;
        }
    }

    return undefined;
}

function removeOption(args: string[], longName: string, shortName: string): string[] {
    const cleanedArgs: string[] = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];

        if (arg === longName || arg === shortName) {
            const nextValue = args[index + 1];

            // Skip flag and its value if the next token is an option value.
            if (nextValue && !nextValue.startsWith('-')) {
                index++;
            }

            continue;
        }

        if (arg.startsWith(`${longName}=`) || arg.startsWith(`${shortName}=`)) {
            continue;
        }

        cleanedArgs.push(arg);
    }

    return cleanedArgs;
}

function isOddMinorVersion(version: string): boolean {
    const parsedVersion = parseSemver(version);

    if (!parsedVersion) {
        throw new Error(`Invalid package version: ${version}`);
    }

    return parsedVersion.minor % 2 === 1;
}

function isBusyFileError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\bEBUSY\b|resource busy or locked/i.test(message);
}

function sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// default target: host OS and architecture
const defaultTarget = `${os.platform()}-${os.arch()}`;
const parsedTarget = getOptionValue(argv, '--target', '-t');
const target = parsedTarget ?? defaultTarget;

if (!parsedTarget) {
    // Ignore malformed/empty --target usage and package for the current host by default.
    if (argv.includes('--target') || argv.includes('-t') || argv.some(arg => arg.startsWith('--target=')) || argv.some(arg => arg.startsWith('-t='))) {
        console.warn(`Missing value for --target/-t. Falling back to default target: ${defaultTarget}`);
    }

    const normalizedArgs = removeOption(argv, '--target', '-t');
    argv.length = 0;
    argv.push(...normalizedArgs, '--target', target);
}

// copy pre-downloaded node-pty for the target platform
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
const version = packageJson.version;

if (!version) {
    throw new Error(`Missing version in ${packageJsonPath}`);
}

if (isOddMinorVersion(version) && !argv.includes('--pre-release')) {
    argv.push('--pre-release');
}

// Ship the README's images inside the VSIX.
//
// vsce rewrites relative README links to absolute URLs under package.json's
// `repository`, so the extension page loaded assets/architecture.png from
// whatever that GitHub branch happened to hold - not the diagram this build
// was made from. VS Code's extension page renders images only from https:
// and data: sources (it does not serve files out of the extension folder), so
// the only way to ship the picture with the package is to inline it. The
// packaged readme is generated here: relative images become data: URIs,
// other relative links are rewritten the way vsce would have, and README.md in
// the repository keeps its plain relative paths so GitHub renders it as-is.
const repoRoot = path.resolve(__dirname, '..');
const inlineImageExtensions: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

function repositoryBase(): { content: string; images: string } | undefined {
    const repository = (packageJson as { repository?: string | { url?: string } }).repository;
    const url = typeof repository === 'string' ? repository : repository?.url;
    const match = url && /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    if (!match) {
        return undefined;
    }
    return {
        content: `https://github.com/${match[1]}/blob/HEAD/`,
        images: `https://github.com/${match[1]}/raw/HEAD/`,
    };
}

function isRelativeLink(link: string): boolean {
    return !/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith('#') && !link.startsWith('/');
}

function buildPackagedReadme(): string {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const base = repositoryBase();
    let inlined = 0;
    const out = readme.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (whole, bang: string, text: string, link: string, title: string) => {
        if (!isRelativeLink(link)) {
            return whole;
        }
        if (bang) {
            const file = path.join(repoRoot, link.split('#')[0]);
            const mime = inlineImageExtensions[path.extname(file).toLowerCase()];
            if (mime && fs.existsSync(file)) {
                inlined++;
                const data = fs.readFileSync(file).toString('base64');
                return `![${text}](data:${mime};base64,${data}${title})`;
            }
            return base ? `![${text}](${base.images}${link}${title})` : whole;
        }
        return base ? `[${text}](${base.content}${link}${title})` : whole;
    });
    console.log(`Packaged readme: ${inlined} image(s) inlined, relative links rewritten to ${base?.content ?? '(no repository URL)'}`);
    return out;
}

if (!getOptionValue(argv, '--readme-path', '--readme-path')) {
    const packagedReadme = path.join(repoRoot, 'out', 'readme.vsix.md');
    fs.mkdirSync(path.dirname(packagedReadme), { recursive: true });
    fs.writeFileSync(packagedReadme, buildPackagedReadme());
    // vsce's rewriting (and its https-only image check) would undo the inlining.
    argv.push('--readme-path', path.relative(repoRoot, packagedReadme), '--no-rewrite-relative-links');
}

// package the extension for the target platform
const command = `vsce package ${argv.join(' ')}`;
console.log(`Running command: ${command}`);
const maxAttempts = 3;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
        execSync(command, { stdio: 'inherit' });
        break;
    } catch (error) {
        if (!isBusyFileError(error) || attempt === maxAttempts) {
            throw error;
        }

        const retryDelayMs = attempt * 1500;
        console.warn(`Packaging hit EBUSY (attempt ${attempt}/${maxAttempts}), retrying in ${retryDelayMs}ms...`);
        sleep(retryDelayMs);
    }
}
