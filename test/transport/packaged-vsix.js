// Verify a built VSIX against the layout it actually installs as.
//
// The esbuild bundle marks `serialport` external because node-gyp-build
// resolves its native .node relative to __dirname at runtime. That means the
// VSIX has to carry serialport's whole transitive subtree, listed by hand in
// .vscodeignore. A missing entry there fails *only* in the packaged extension —
// in development the full node_modules is present and everything looks fine.
//
// So: unpack the VSIX to a temp dir and load from there, exactly as VS Code
// would. Run after `vsce package`:
//
//   node test/transport/packaged-vsix.js cmsis-developer-assistant-<version>.vsix

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) { failures++; }
}

const vsix = process.argv[2];
if (!vsix || !fs.existsSync(vsix)) {
    console.error(`usage: node ${path.basename(__filename)} <path-to.vsix>`);
    process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-vsix-'));
execFileSync('unzip', ['-q', path.resolve(vsix), '-d', tmp]);
// VS Code installs the contents of `extension/` as the extension root.
const root = path.join(tmp, 'extension');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(`packaged ${pkg.name}@${pkg.version}, main=${pkg.main}\n`);

// 1. The entry point named by package.json is actually in the VSIX.
const mainPath = path.join(root, pkg.main);
check('package.json main exists in the VSIX', fs.existsSync(mainPath), pkg.main);

// 2. Test code is not shipped. Compiled tests carry credential-shaped fixtures
//    from the redaction suite and nothing loads them.
check('no compiled tests are shipped',
    !fs.existsSync(path.join(root, 'out', 'test')) && !fs.existsSync(path.join(root, 'src')));

// 3. THE BUNDLE ACTUALLY LOADS.
//     This is the check whose absence shipped a broken 2.0.2: esbuild left an
//     untraceable `require("./impl/format")` from jsonc-parser's UMD wrapper in
//     the bundle, so activation died instantly — while every other check here
//     passed, because they never required the entry point. "It packaged" says
//     nothing about whether it runs.
let loadOk = false;
let loadDetail = '';
try {
    const loaded = execFileSync(process.execPath, ['-e',
        `require(${JSON.stringify(path.resolve(__dirname, 'vscode-stub.js'))});` +
        `const m = require(${JSON.stringify(mainPath)});` +
        `if (typeof m.activate !== 'function') { throw new Error('no activate export'); }` +
        `if (typeof m.deactivate !== 'function') { throw new Error('no deactivate export'); }` +
        `console.log('ok')`,
    ], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    loadOk = loaded.endsWith('ok');
    loadDetail = loadOk ? 'activate/deactivate exported' : loaded;
} catch (err) {
    loadDetail = String(err.stderr || err.message).split('\n').find(l => /Error|Cannot/.test(l))
        || String(err.message).split('\n')[0];
}
check('the bundle loads and exports activate/deactivate', loadOk, loadDetail);

// 4. serialport resolves *from the packaged tree*. This is the allow-list check.
let serialportOk = false;
let serialportDetail = '';
try {
    const sp = require(path.join(root, 'node_modules', 'serialport'));
    serialportOk = typeof sp.SerialPort === 'function';
    serialportDetail = serialportOk ? 'SerialPort constructor present' : `unexpected exports: ${Object.keys(sp).join(', ')}`;
} catch (err) {
    serialportDetail = err.message.split('\n')[0];
}
check('serialport loads from the packaged tree', serialportOk, serialportDetail);

// 5. The native binding really binds — the failure node-gyp-build produces when
//    its prebuild directory is missing, which is the whole reason for step 3.
let bindingOk = false;
let bindingDetail = '';
try {
    const { SerialPort } = require(path.join(root, 'node_modules', 'serialport'));
    const ports = execFileSync(process.execPath, ['-e',
        `const {SerialPort}=require(${JSON.stringify(path.join(root, 'node_modules', 'serialport'))});` +
        `SerialPort.list().then(p=>{console.log(JSON.stringify(p.length));process.exit(0)})` +
        `.catch(e=>{console.error(e.message);process.exit(1)})`,
    ], { encoding: 'utf8', timeout: 30_000 }).trim();
    bindingOk = /^\d+$/.test(ports);
    bindingDetail = bindingOk ? `SerialPort.list() returned ${ports} port(s)` : ports;
    void SerialPort;
} catch (err) {
    bindingDetail = String(err.stderr || err.message).split('\n')[0];
}
check('the native binding loads and enumerates ports', bindingOk, bindingDetail);

// 6. The bundle did not swallow serialport — if it had, the require above could
//    pass while the extension still used a broken inlined copy.
const bundle = fs.readFileSync(mainPath, 'utf8');
check('the bundle keeps serialport external',
    /require\(["']serialport["']\)/.test(bundle),
    'bundle require()s serialport at runtime rather than inlining it');

// 7. The skills ship, since activation copies the selected ones out of the
//    extension: the bundled debugging skill, the catalog that drives the
//    picker, the upstream lock, and every SKILL.md the catalog points at.
check('the agent skill ships', fs.existsSync(path.join(root, 'skills', 'cmsis-debug-live', 'SKILL.md')));
check('the help skill ships', fs.existsSync(path.join(root, 'skills', 'cmsis-help', 'SKILL.md')));
check('the skill catalog ships', fs.existsSync(path.join(root, 'skills', 'catalog.json')));
check('the upstream skill lock ships', fs.existsSync(path.join(root, 'skills', 'cmsis-skills.lock.json')));
let catalogOk = false;
let catalogDetail = '';
try {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'skills', 'catalog.json'), 'utf8'));
    const missing = catalog.skills
        .filter(entry => !fs.existsSync(path.join(root, entry.path, 'SKILL.md')))
        .map(entry => entry.name);
    catalogOk = catalog.skills.length > 1 && missing.length === 0;
    catalogDetail = missing.length ? `missing: ${missing.join(', ')}` : `${catalog.skills.length} skills present`;
} catch (err) {
    catalogDetail = err.message;
}
check('every catalog skill ships', catalogOk, catalogDetail);
check('the upstream licence ships', fs.existsSync(path.join(root, 'skills', 'cmsis-skills', 'LICENSE')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
