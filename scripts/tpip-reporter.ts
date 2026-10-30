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

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';

async function main() {

    const { json, report, header, knowledge } = yargs(hideBin(process.argv))
        .usage('Usage: $0 <json> <report> [--header <header>] [--knowledge <SOURCES.md>]')
        .options('header', {
            describe: 'Header to add to the report',
            type: 'string'
        })
        .options('knowledge', {
            describe: 'The SOURCES.md of the core knowledge index; its table of sources becomes the last section',
            type: 'string'
        })
        .command('$0 <json> <report>', '', y => {
            y.positional('json', {
                describe: 'JSON file to parse',
                type: 'string'
            });
            y.positional('report', {
                describe: 'Report file to generate',
                type: 'string'
            });
        })
        .help('h')
        .version(false)
        .strict()
        .parseSync();

    const tpipJson = JSON.parse(fs.readFileSync(json as string, 'utf8'));

    let release: string | undefined;
    if (fs.existsSync('package.json')) {
        const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        release = packageJson.version;
    }

    let data: string = '';
    if (header && fs.existsSync(header as string)) {
        data += fs.readFileSync(header as string, 'utf8');
    } else {
        data += '# TPIP Report\n\n';
    }

    data += '\n';
    if (release) {
        data += `Generated for release: ${release}\n\n`;
    } else {
        data += `Report prepared at: ${new Date().toLocaleString('en-GB')}\n\n`;
    }
    data += '| *Package* | *Version* | *Repository* | *License* |\n';
    data += '| --- | --- | --- | --- |\n';

    for (const value of tpipJson) {
        data += `| ${value.name} | ${value.version} | ${value.url} | [${value.spdx}](${value.license}) |\n`;
    }

    if (knowledge) {
        data += knowledgeSection(knowledge as string);
    }

    fs.writeFileSync(report as string, data);
}

/**
 * The sources of the core knowledge index, from the table of its SOURCES.md
 * (the knowledge base generates the file; the extension commits the copy it
 * ships as resources/knowledge/SOURCES.md). The table sits between the markers
 * `<!-- sources:table:begin -->` and `<!-- sources:table:end -->`.
 */
function knowledgeSection(sourcesFile: string): string {
    const text = fs.readFileSync(sourcesFile, 'utf8');
    const begin = text.indexOf('<!-- sources:table:begin -->');
    const end = text.indexOf('<!-- sources:table:end -->');
    if (begin < 0 || end < begin) {
        throw new Error(`${sourcesFile} has no sources table between the markers`);
    }
    const table = text.slice(begin + '<!-- sources:table:begin -->'.length, end).trim();
    return '\n## Knowledge index\n\n'
        + 'The core knowledge index `resources/knowledge/core.db` is derived from the sources below under their licences '
        + '(Apache-2.0, MIT, BSD-3-Clause) and from summaries in our own words. `resources/knowledge/SOURCES.md` lists them with '
        + 'the copyright lines, licence texts and NOTICE files those licences require; this table is its table of sources.\n\n'
        + table + '\n';
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
