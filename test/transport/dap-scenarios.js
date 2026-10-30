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

// DAP scenario oracle.
//
// Drives the real MCP server (single-window default constructor) over HTTP
// against a SCRIPTED gdbtarget debug session and records, per tool call, the
// reply the agent sees and the traffic the call caused: DAP requests sent
// through session.customRequest, VS Code commands executed, debug API calls
// (breakpoints, start/stop), and the adapter events the script emitted.
//
//   node test/transport/dap-scenarios.js                 compare with the snapshot
//   node test/transport/dap-scenarios.js --update        rewrite the snapshot
//   node test/transport/dap-scenarios.js --only=<name>   run one scenario, print it, compare nothing
//
// No VS Code window, network, probe or GDB is involved: `vscode` is the stub
// from vscode-stub.js, extended below with a fake debug session, adapter
// tracker, breakpoint model, tasks and command log.
//
// The scripted adapter answers the way cdt-gdb-adapter (the adapter behind
// `gdbtarget`) answers, including where that exposes bugs in the code under
// test. Only REPL input starting with '>' is a GDB command: an evaluate of
// `-exec <cmd>` is handed to GDB as an expression, -var-create fails, and the
// adapter answers SUCCESS with the result text "Error: could not evaluate
// expression". A '>' CLI command answers '\r' and prints its text as `output`
// events of category stdout (GDB's console and target streams); a '>' MI
// command (`>-data-read-memory-bytes`, `>-dprintf-insert`, `>-break-list`)
// answers its MI result as JSON, with the adapter's `cdt-token` and
// `cdt-command` fields; a command GDB refuses is an error response with GDB's
// text. The scripted GDB keeps a breakpoint table (the launch configuration's
// `break main` is number 1): `dprintf` prints "Dprintf N at …" and the adapter
// announces the new breakpoint with a `breakpoint` event, which an MI
// `-dprintf-insert` does not; `condition`, `delete` (unknown numbers print
// "No breakpoint number N.") and `info breakpoints` work on it. `monitor reset
// …` resets the core as pyOCD or J-Link would and prints their text, but GDB
// does not see it: registers keep their old values until `maintenance flush
// register-cache`. Other fidelity choices:
//   - frame handles are 1000 + level (thread 1), as the adapter's first
//     allocation after a stop; they are invalid while the target runs;
//   - registers evaluate in GDB's natural format for pyOCD's target
//     description: r0-r12, lr, xpsr, control, ... are `int` (signed decimal,
//     so EXC_RETURN 0xfffffff9 reads "-7"), sp/msp/psp and the Security
//     Extension's msp_s/psp_s/msp_ns/psp_ns are `void *`, pc is a code
//     pointer "0x80002fe <main+22>", an unknown `$name` is `void`;
//   - an inaccessible -data-read-memory-bytes fails "Unable to read memory.";
//     a wedged probe (`wedged`) makes every address inaccessible, DHCSR
//     included, while threads, stack and registers still answer from GDB's
//     caches;
//     GDB MI and CLI commands on a running all-stop remote target fail with
//     GDB's "Cannot execute this command while the target is running." text
//     (the breakpoint table can still be listed);
//   - lines with code are listed per source file; a breakpoint on a line
//     without code moves to the next line with code, past the last one GDB
//     answers "No line N in file".
//   - the GDB server's own output (pyOCD's log) is category `server`, as
//     cdt-gdb-adapter 1.10 forwards the server's stdout and stderr.
//   - a session with `connectMs` takes no requests while GDB connects, and
//     none after `serverExits` while it shuts down: cdt-gdb-adapter answers
//     every request then with an empty success that carries no body. Once
//     connected it sends `initialized` and answers the launch or attach
//     request, or answers it with GDB's error (`connectFails`).
// VS Code itself is modelled only as far as the code under test can see it:
// after a stopped event `activeStackItem` becomes frame 1000 of the focused
// session at once, a continued event and the session's end clear it, and
// each change fires `onDidChangeActiveStackItem` with a new item object, as
// VS Code does; a change of the breakpoint
// model makes VS Code send `setBreakpoints` for each file concerned a moment
// later, which the adapter answers as cdt-gdb-adapter does (the file's GDB
// breakpoints whose location names the file and that VS Code did not send are
// deleted), and `getDebugProtocolBreakpoint` returns that answer afterwards.
// VS Code's other DAP traffic (its stackTrace after a stop) is not modelled,
// nor are the breakpoints VS Code adds to its own model when the adapter
// announces a new one; the breakpoint model is a plain list without
// de-duplication.
//
// Scenarios are independent: each gets a fresh server, a fresh fake session
// and an empty breakpoint model, the breakpoints the session tracker saw VS
// Code adopt from an adapter included. Module-level state in the code under test
// (the window's problem journal, whose record numbers count on across
// scenarios and are masked in the replies, the pack-root answer, the parsed
// SVD cache) persists across scenarios as it does across sessions in one
// extension host; `cmsis-csolution.getPackRootPath` is answered but not
// logged, because it is asked once per process and would otherwise tie the
// log of one scenario to the order they run in.
//
// A refactoring or rewrite that is meant to change no behaviour must leave
// the replies identical; the traffic lists show what a changed reply was
// built from. A deliberate change updates the snapshot in the same commit.

const stub = require('./vscode-stub.js');

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');
const SNAPSHOT = path.join(__dirname, 'dap-scenarios.snapshot.json');
/** Replies whose structuredContent leaves out part of their text (see surface-snapshot.js). */
const uncarried = [];
/** From the compiled code, loaded in main() after the stub is in place. */
let linesMissingFromStructured;
const CALL_TIMEOUT_MS = 90_000;

// ── Stub extensions ────────────────────────────────────────────────────────

function emitter() {
    const listeners = new Set();
    return {
        event: (fn) => { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
        fire: (e) => { for (const l of [...listeners]) { l(e); } },
    };
}

const bus = {
    didStart: emitter(),
    didTerminate: emitter(),
    didChangeActiveSession: emitter(),
    didChangeStackItem: emitter(),
    taskStart: emitter(),
    taskEnd: emitter(),
};
const trackerFactories = [];

/** The scenario being recorded; the stub hooks delegate to it. */
let current = null;

function describeBreakpoint(bp) {
    const where = `${bp.location.uri.fsPath}:${bp.location.range.start.line + 1}`;
    const mods = [];
    if (bp.condition) { mods.push(`when: ${bp.condition}`); }
    if (bp.logMessage) { mods.push(`log: ${bp.logMessage}`); }
    return mods.length ? `${where} [${mods.join(', ')}]` : where;
}

Object.assign(stub.debug, {
    breakpoints: [],
    registerDebugAdapterTrackerFactory(_type, factory) {
        trackerFactories.push(factory);
        return { dispose() { trackerFactories.splice(trackerFactories.indexOf(factory), 1); } };
    },
    onDidStartDebugSession: bus.didStart.event,
    onDidTerminateDebugSession: bus.didTerminate.event,
    onDidChangeActiveDebugSession: bus.didChangeActiveSession.event,
    onDidChangeActiveStackItem: bus.didChangeStackItem.event,
    async startDebugging(folder, nameOrConfig) {
        const name = typeof nameOrConfig === 'string' ? nameOrConfig : nameOrConfig?.name;
        current.record(`vscode: debug.startDebugging folder=${folder?.uri?.fsPath ?? '<none>'} configuration=${JSON.stringify(name)}`);
        return current.startDebugging(name);
    },
    async stopDebugging(session) {
        current.record(`vscode: debug.stopDebugging session=${JSON.stringify(session?.name ?? null)}`);
        if (session && current.holdsStop(session)) { return new Promise(() => {}); }
        if (session) { current.endSession(session); }
    },
    addBreakpoints(bps) {
        current.record(`vscode: debug.addBreakpoints ${bps.map(describeBreakpoint).join(', ')}`);
        stub.debug.breakpoints = [...stub.debug.breakpoints, ...bps];
        current.syncBreakpoints(bps);
    },
    removeBreakpoints(bps) {
        current.record(`vscode: debug.removeBreakpoints ${bps.map(describeBreakpoint).join(', ')}`);
        stub.debug.breakpoints = stub.debug.breakpoints.filter((bp) => !bps.includes(bp));
        current.syncBreakpoints(bps);
    },
});

stub.tasks = { onDidStartTaskProcess: bus.taskStart.event, onDidEndTaskProcess: bus.taskEnd.event };

// Real files, read the way VS Code's TextDocument exposes them.
stub.workspace.openTextDocument = async (uri) => {
    const fsPath = uri.fsPath;
    let text;
    try {
        text = fs.readFileSync(fsPath, 'utf8');
    } catch {
        throw new Error(`cannot open ${uri.toString()}. Detail: Unable to read file '${fsPath}' ` +
            `(Error: Unable to resolve nonexistent file '${fsPath}')`);
    }
    const lines = text.split(/\r?\n/);
    return { uri, lineCount: lines.length, lineAt: (i) => ({ text: lines[i] }), getText: () => text };
};

// Asked once per process and cached by the code under test — see the header.
const UNLOGGED_COMMANDS = new Set(['cmsis-csolution.getPackRootPath']);

stub.commands.executeCommand = async (command, ...args) => {
    if (!current) { return undefined; }
    if (!UNLOGGED_COMMANDS.has(command)) {
        current.record(`command: ${command}${args.length ? ` ${JSON.stringify(args)}` : ''}`);
    }
    const handler = current.commands[command];
    return handler ? handler(current, ...args) : undefined;
};

// ── The scripted target ────────────────────────────────────────────────────

const RUNNING_MSG = 'Cannot execute this command while the target is running.\n' +
    'Use the "interrupt" command to stop the target\nand then try again.';
const NOT_EVALUATED = 'Error: could not evaluate expression';
const GDB_BANNER = '\nIn the Debug Console view you can interact directly with GDB.\n' +
    'To display the value of an expression, type that expression which can reference\n' +
    "variables that are in scope. For example type '2 + 3' or the name of a variable.\n" +
    "Arbitrary commands can be sent to GDB by prefixing the input with a '>',\n" +
    "for example type '>show version' or '>help'.\n\n";

const FUNCTIONS = [
    ['Reset_Handler', 0x08000198], ['NMI_Handler', 0x080001a0], ['HardFault_Handler', 0x080001a4],
    ['delay_ms', 0x08000248], ['led_init', 0x08000260], ['led_toggle', 0x08000268], ['main', 0x080002e8],
    ['parse_node', 0x08000480], ['sensor_task', 0x08000540], ['osRtxIdleThread', 0x08001a30],
];

function symbolise(addr) {
    let best = null;
    for (const [name, start] of FUNCTIONS) {
        if (start <= addr && (!best || start > best[1])) { best = [name, start]; }
    }
    if (!best || addr - best[1] > 0x100) { return `0x${addr.toString(16)}`; }
    const off = addr - best[1];
    return `0x${addr.toString(16)} <${best[0]}${off ? `+${off}` : ''}>`;
}

const hex = (n) => `0x${(n >>> 0).toString(16)}`;

/** The lines of each source file that have code: line → [address, function]. */
const CODE_LINES = {
    'main.c': {
        17: [0x0800024c, 'delay_ms'], 18: [0x08000252, 'delay_ms'],
        21: [0x080002e8, 'main'], 22: [0x080002ea, 'main'], 23: [0x080002ec, 'main'], 24: [0x080002ee, 'main'],
        25: [0x080002f0, 'main'], 26: [0x080002f2, 'main'], 27: [0x080002f2, 'main'], 29: [0x080002f4, 'main'],
        30: [0x080002f8, 'main'], 31: [0x080002fe, 'main'], 32: [0x08000302, 'main'], 33: [0x0800030a, 'main'],
    },
    'led.c': {
        12: [0x08000260, 'led_init'], 13: [0x08000262, 'led_init'], 14: [0x08000266, 'led_init'],
        16: [0x08000268, 'led_toggle'], 17: [0x0800026c, 'led_toggle'], 18: [0x08000276, 'led_toggle'], 19: [0x0800027e, 'led_toggle'],
    },
};

/**
 * Where GDB puts a breakpoint on `line` of `file`: that line or the next one
 * with code. `file` is matched as GDB matches a linespec, by its trailing path
 * components; undefined `where` means no such line, null no such file.
 */
function resolveSourceLine(file, line) {
    const name = path.basename(String(file).replace(/\\/g, '/'));
    const lines = CODE_LINES[name];
    if (!lines) { return null; }
    const found = Object.keys(lines).map(Number).sort((a, b) => a - b).find((candidate) => candidate >= line);
    if (found === undefined) { return { name, where: undefined }; }
    const [addr, fn] = lines[found];
    return { name, where: { line: found, addr, fn } };
}

/** The arguments of an MI command line: words, and c-strings with their escapes resolved. */
function miArguments(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        while (text[i] === ' ') { i++; }
        if (i >= text.length) { break; }
        if (text[i] === '"') {
            let value = '';
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\' && i + 1 < text.length) {
                    const next = text[i + 1];
                    value += next === 'n' ? '\n' : next;
                    i += 2;
                } else {
                    value += text[i++];
                }
            }
            i++;
            out.push(value);
        } else {
            let word = '';
            while (i < text.length && text[i] !== ' ') { word += text[i++]; }
            out.push(word);
        }
    }
    return out;
}

/** A format string as GDB writes it back into a printf command: newline and quote escaped. */
function printfLiteral(format) {
    return `"${format.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Where the target can stop. `file` is a project-relative source, or null for no debug info. */
function frame(fn, file, line, addr) { return { fn, file, line, addr }; }
const LOCATIONS = {
    main29: [frame('main', 'main.c', 29, 0x080002f4)],
    main31: [frame('main', 'main.c', 31, 0x080002fe)],
    main32: [frame('main', 'main.c', 32, 0x08000302)],
    ledToggle17: [frame('led_toggle', 'led.c', 17, 0x0800026c), frame('main', 'main.c', 31, 0x08000302)],
    ledToggle18: [frame('led_toggle', 'led.c', 18, 0x08000276), frame('main', 'main.c', 31, 0x08000302)],
    delayLoop: [frame('delay_ms', 'main.c', 17, 0x08000256), frame('main', 'main.c', 32, 0x08000306)],
    hardFault: [
        frame('HardFault_Handler', null, 0, 0x080001a4), frame('<signal handler called>', null, 0, 0xfffffff9),
        frame('led_toggle', 'led.c', 18, 0x0800027a), frame('main', 'main.c', 31, 0x08000302),
    ],
    // The Non-secure HardFault handler, entered from Secure Thread code (TrustZone, AIRCR.BFHFNMINS=1).
    hardFaultFromSecure: [
        frame('HardFault_Handler', null, 0, 0x080001a4), frame('<signal handler called>', null, 0, 0xfffffff8),
        frame('led_toggle', 'led.c', 18, 0x0800027a), frame('main', 'main.c', 31, 0x08000302),
    ],
    resetHandler: [frame('Reset_Handler', null, 0, 0x08000198)],
};

const BASE_REGS = {
    r0: 0x2a, r1: 0x40020000, r2: 0x20, r3: 0x20000010, r4: 0x1f4, r5: 0, r6: 0, r7: 0x20017fd0,
    r8: 0, r9: 0, r10: 0, r11: 0, r12: 0x08000f10, sp: 0x20017fd0, lr: 0x080001b1,
    xpsr: 0x61000000, psp: 0, primask: 0, basepri: 0, faultmask: 0, control: 0,
};
const REG_OVERRIDES = {
    ledToggle17: { sp: 0x20017fc8, r7: 0x20017fc8, lr: 0x08000303 },
    ledToggle18: { sp: 0x20017fc8, r7: 0x20017fc8, lr: 0x08000303, r3: 0x20 },
    delayLoop: { sp: 0x20017fc0, r7: 0x20017fc0, lr: 0x08000307, r3: 0x3039, r2: 0x7a120 },
    hardFault: { r0: 0x5fffffec, r1: 0x20, r2: 0, r3: 0x20000010, r12: 0, sp: 0x20017fa8, r7: 0x20017fc8, lr: 0xfffffff9, xpsr: 0x61000003 },
    // MSP and PSP are the Non-secure ones; the frame is on PSP_S, which CONTROL_S.SPSEL selects.
    hardFaultFromSecure: {
        r0: 0, r1: 0, r2: 0, r3: 0, r12: 0, sp: 0x20017fa8, r7: 0x20017fc8, lr: 0xfffffff8, xpsr: 0x61000003,
        msp_s: 0x20016fe0, psp_s: 0x20016f00, control_s: 2,
    },
    resetHandler: { r0: 0, r1: 0, r2: 0, r3: 0, r4: 0, r7: 0, r12: 0, sp: 0x20018000, lr: 0xffffffff, xpsr: 0x01000000 },
};
const REGISTER_ORDER = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12',
    'sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'primask', 'basepri', 'faultmask', 'control'];

/** Symbols GDB can evaluate: [value, type, children?]; a child is [name, value, type, children?]. */
const GLOBALS = {
    SystemCoreClock: ['84000000', 'uint32_t'],
    sensor: ['{...}', 'sensor_t', [
        ['id', "3 '\\003'", 'uint8_t'],
        ['cal', '{...}', 'cal_t', [['offset', '-12', 'int16_t'], ['gain', '1.25', 'float']]],
        ['samples', '{...}', 'uint16_t [40]', Array.from({ length: 40 }, (_, i) => [`[${i}]`, String(i * 10), 'uint16_t'])],
        ['token', '"tk-7f3a9c21"', 'char [12]', [...'tk-7f3a9c21'].map((c, i) => [`[${i}]`, `${c.charCodeAt(0)} '${c}'`, 'char'])],
    ]],
    counter: ['42', 'volatile uint32_t'],
    'counter * 2': ['84', 'unsigned long'],
};
const LOCALS = {
    main: {
        config: ['{...}', 'led_config_t', [['period_ms', '500', 'uint32_t'], ['pin', "5 '\\005'", 'uint8_t']]],
        ledState: ['true', '_Bool'],
        buffer: ['"Hello, Cortex-M!"', 'char [16]', [...'Hello, Cortex-M!'].map((c, i) => [`[${i}]`, `${c.charCodeAt(0)} '${c}'`, 'char'])],
        password: ['0x8000f10 "hunter2"', 'const char *', [['*password', "104 'h'", 'const char']]],
        api_key: ['"AK-7f3a9c21e0b4"', 'char [16]', [...'AK-7f3a9c21e0b4'].map((c, i) => [`[${i}]`, `${c.charCodeAt(0)} '${c}'`, 'char'])],
    },
    led_toggle: { mask: ['32', 'uint32_t'] },
    delay_ms: { ms: ['500', 'uint32_t'], i: ['12345', 'volatile uint32_t'] },
};

const THREAD_SETS = {
    single: [{ id: 1, name: '1' }],
    rtx: [
        { id: 1, name: 'app_main (Running; Priority 24)' },
        { id: 2, name: 'osRtxIdleThread (Ready; Priority 1)', frames: [frame('osRtxIdleThread', '@packs/ARM/CMSIS-RTX/5.9.0/Source/rtx_lib.c', 546, 0x08001a42)] },
        {
            id: 3, name: 'sensor_task (Waiting; Priority 24)',
            frames: [
                ...Array.from({ length: 24 }, (_, i) => frame('parse_node', 'sensor.c', 41 + (i % 2) * 3, 0x080004c2 + (i % 2) * 8)),
                frame('sensor_task', 'sensor.c', 88, 0x08000566),
            ],
        },
    ],
};

/** Target memory: word values by address; everything outside READABLE fails. */
const READABLE = [[0x08000000, 0x08080000], [0x20000000, 0x20018000], [0x40000000, 0x40080000], [0xe0000000, 0xe0100000]];
function baseMemory() {
    const words = new Map();
    const bytes = (addr, list) => {
        for (let i = 0; i < list.length; i += 4) {
            const w = (list[i] ?? 0) | ((list[i + 1] ?? 0) << 8) | ((list[i + 2] ?? 0) << 16) | ((list[i + 3] ?? 0) << 24);
            words.set(addr + i, w >>> 0);
        }
    };
    const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
    // Vector table.
    words.set(0x08000000, 0x20018000); words.set(0x08000004, 0x08000199);
    words.set(0x08000008, 0x080001a1); words.set(0x0800000c, 0x080001a5);
    // SRAM: text, counter, more text, a marker, and erased bytes.
    bytes(0x20000000, [
        ...ascii('Hello, Cortex-M!'), 0x2a, 0, 0, 0, ...ascii('UART2 ready\r\n'), 0, 0, 0,
        0xef, 0xbe, 0xad, 0xde, ...ascii('The quick brown fox jumps over. '), ...Array(8).fill(0xff),
    ]);
    // Exception frame of the HardFault scenario (at its MSP).
    [0x5fffffec, 0x20, 0, 0x20000010, 0, 0x08000303, 0x0800027a, 0x21000000]
        .forEach((w, i) => words.set(0x20017fa8 + 4 * i, w));
    // Peripherals.
    words.set(0x40023800, 0x03000083); words.set(0x40023830, 0x00000001);          // RCC CR, AHB1ENR
    words.set(0x40020000, 0xa8000400); words.set(0x40020010, 0x0000a020);          // GPIOA MODER, IDR
    words.set(0x40020014, 0x00000020);                                             // GPIOA ODR
    words.set(0x40020400, 0x00000280);                                             // GPIOB MODER
    words.set(0x40004400, 0x000000c0); words.set(0x40004408, 0x0000016d);          // USART2 SR, BRR
    words.set(0x4000440c, 0x0000200c);                                             // USART2 CR1
    // System control space and DWT.
    words.set(0xe000ed00, 0x410fc241); words.set(0xe000ed08, 0x08000000);          // CPUID, VTOR
    words.set(0xe0001000, 0x40000000); words.set(0xe0001004, 0x00a3c1f5);          // DWT_CTRL, CYCCNT
    words.set(0xe000edf0, 0x00030003);                                             // DHCSR: halted, C_DEBUGEN
    return words;
}
const FAULT_WORDS = { 0xe000ed28: 0x00008200, 0xe000ed2c: 0x40000000, 0xe000ed30: 0x00000008, 0xe000ed34: 0x60000000, 0xe000ed38: 0x60000000 };
/**
 * The frame on PSP_S of `hardFaultFromSecure`: integrity signature, reserved word, R4–R11, then R0–xPSR at
 * +0x28. Its R0 differs from the frame the base memory holds at the Non-secure MSP.
 */
const SECURE_FRAME_WORDS = Object.fromEntries([
    0xfefa125b, 0, 0x1f4, 0, 0, 0x20016f48, 0, 0, 0, 0,
    0x60000000, 0x20, 0, 0x20000010, 0, 0x08000303, 0x0800027a, 0x21000000,
].map((w, i) => [0x20016f00 + 4 * i, w]));

class FakeTarget {
    constructor(sc, spec, session) {
        this.sc = sc;
        this.spec = spec;
        this.session = session;
        this.state = 'stopped';
        this.at = null;
        this.queue = (spec.stops ?? []).map((s) => ({ ...s }));
        this.runningAt = spec.runningAt ?? 'delayLoop';
        this.failures = { ...(spec.failures ?? {}) };
        this.threadSet = THREAD_SETS[spec.threads ?? 'single'];
        this.words = baseMemory();
        for (const [a, v] of Object.entries(spec.memory ?? {})) { this.words.set(Number(a), v >>> 0); }
        this.hung = false;
        this.dead = false;
        /** cdt-gdb-adapter takes requests from its launch or attach answer until the session shuts down (`connectMs`, `serverExits`). */
        this.ready = true;
        this.tracker = null;
        this.seq = 1;
        // GDB's breakpoint table; a launch configuration's initCommands set `break main` first.
        const launched = (spec.config ?? 'pyocd') !== 'pyocd-attach';
        this.gdbBreakpoints = launched
            ? [{ number: 1, type: 'breakpoint', file: 'main.c', line: 22, addr: 0x080002ea, fn: 'main', location: 'main', hits: 1 }]
            : [];
        this.nextBreakpoint = launched ? 2 : 1;
        /** What the adapter answered VS Code for each model breakpoint. */
        this.bindings = new Map();
        /** Where a monitor reset left the core while GDB's register cache still shows `at`. */
        this.resetAt = null;
        this.miToken = 0;
        this.valueHistory = 0;
        /** Children behind the variablesReference of an evaluate result, as GDB's varobjs: reference → children. */
        this.varobjChildren = new Map();
        this.nextVarobj = 5000;
    }

    /** A variablesReference for `kids`, as the adapter hands out one per varobj with children. */
    varobjReference(kids) {
        if (!kids || kids.length === 0) { return 0; }
        const reference = this.nextVarobj++;
        this.varobjChildren.set(reference, kids);
        return reference;
    }

    attachTracker() {
        const trackers = trackerFactories.map((f) => f.createDebugAdapterTracker(this.session)).filter(Boolean);
        for (const t of trackers) { t.onWillStartSession?.(); }
        this.tracker = {
            send: (m) => { for (const t of trackers) { t.onDidSendMessage?.({ seq: this.seq++, ...m }); } },
            receive: (m) => { for (const t of trackers) { t.onWillReceiveMessage?.(m); } },
            willStop: () => { for (const t of trackers) { t.onWillStopSession?.(); } },
        };
    }

    focused() { return stub.debug.activeDebugSession === this.session; }

    /** VS Code's focused frame follows this session only while it is the active one. */
    setStackItem(item) {
        if (!this.focused()) { return; }
        stub.debug.activeStackItem = item;
        bus.didChangeStackItem.fire(item);
    }

    emit(event, body) {
        const shown = event === 'output'
            ? `[${body.category}] ${JSON.stringify(String(body.output).trim().split('\n')[0])}`
            : JSON.stringify(body);
        this.sc.record(`event: ${event} ${shown}`);
        this.tracker?.send({ type: 'event', event, body });
    }

    output(category, text) { this.emit('output', { category, output: text }); }

    stopAt(at, reason, threadId = 1) {
        if (this.dead) { return; }
        this.state = 'stopped';
        this.at = at;
        this.resetAt = null;
        this.emit('stopped', { reason, threadId, allThreadsStopped: true });
        this.setStackItem({ session: this.session, threadId, frameId: 1000 });
    }

    run() {
        if (this.dead) { return; }
        this.state = 'running';
        this.at = null;
        this.emit('continued', { threadId: 1, allThreadsContinued: true });
        this.setStackItem(undefined);
    }

    /** Run the target the way an execution request would, taking the next scripted stop. */
    perform(command) {
        const idx = this.queue.findIndex((s) => s.on === command);
        const stop = idx === -1 ? null : this.queue.splice(idx, 1)[0];
        setTimeout(() => {
            this.run();
            if (stop) { setTimeout(() => this.stopAt(stop.at, stop.reason), stop.delayMs ?? 5); }
        }, 1);
    }

    /** Stop the running target after `delayMs`, as a breakpoint hit would. */
    scheduleStop(delayMs, at, reason) { setTimeout(() => this.stopAt(at, reason), delayMs); }

    /** The GDB server exits: the adapter takes no more requests while it shuts down, and the session ends `afterMs` later. */
    serverExits(afterMs) {
        this.output('server', 'gdbserver exited with code 1\n');
        this.ready = false;
        setTimeout(() => this.sc.endSession(this.session), afterMs);
    }

    // ── requests ──

    request(command, args) {
        const line = `dap: ${command} ${JSON.stringify(args ?? {})}`;
        if (this.dead) {
            const msg = `No debugger available, can not send '${command}'`;
            this.sc.record(`${line} -> error: ${msg}`);
            return Promise.reject(new Error(msg));
        }
        // `threadsHangWhileRunning`: GDB busy with the running target answers no `threads` until a pause stops it.
        if (this.hung || (command === 'threads' && this.spec.threadsHangWhileRunning && this.state === 'running')) {
            this.sc.record(`${line} -> no answer`);
            return new Promise(() => {});
        }
        if (!this.ready) {
            // Its request gate: every request is skipped with a success that carries no body.
            this.sc.record(`${line} -> empty success (adapter not ready)`);
            this.tracker?.send({ type: 'response', command, success: true });
            return Promise.resolve(undefined);
        }
        // Logged before answering: events the adapter emits while it works come after the request.
        const log = this.sc.log;
        const at = log.length;
        log.push(line);
        let body;
        try {
            body = this.answer(command, args ?? {});
        } catch (err) {
            log[at] = `${line} -> error: ${JSON.stringify(err.message)}`;
            this.tracker?.send({ type: 'response', command, success: false, message: err.message, body: { error: { id: 1, format: err.message } } });
            return Promise.reject(new Error(err.message));
        }
        if (command === 'evaluate') { log[at] = `${line} -> ${JSON.stringify(body.result)}`; }
        if (command === 'readMemory' && body?.data) {
            const late = body.address !== hex(Number(args.memoryReference) + (args.offset ?? 0)) ? ` from ${body.address}` : '';
            log[at] = `${line} -> ${Buffer.from(body.data, 'base64').length} bytes${late}`;
        }
        this.tracker?.send({ type: 'response', command, success: true, body });
        return Promise.resolve(body);
    }

    frames(threadId) {
        if (threadId === 1) { return LOCATIONS[this.at] ?? []; }
        return this.threadSet.find((t) => t.id === threadId)?.frames ?? null;
    }

    /** Frame handle → { threadId, level, frame }, valid only while stopped. */
    frameRef(handle) {
        if (this.state !== 'stopped' || typeof handle !== 'number') { return undefined; }
        const threadId = Math.floor((handle - 1000) / 100) + 1;
        const level = (handle - 1000) % 100;
        const frames = this.frames(threadId);
        return frames && level >= 0 && level < frames.length ? { threadId, level, frame: frames[level] } : undefined;
    }

    regs(level = 0) {
        const regs = { ...BASE_REGS, ...(REG_OVERRIDES[this.at] ?? {}) };
        regs.pc = LOCATIONS[this.at][level]?.addr ?? 0;
        regs.msp = regs.sp;
        // An Arm FVP's target description has no msp, psp, control or masks (`noSystemRegisters`): GDB answers void.
        if (this.spec.noSystemRegisters) {
            for (const name of ['msp', 'psp', 'control', 'faultmask', 'basepri', 'primask']) { delete regs[name]; }
        }
        return regs;
    }

    /** A register in GDB's natural format, per pyOCD's target description. */
    naturalRegister(name, regs) {
        const v = regs[name];
        if (v === undefined) { return { value: 'void', type: 'void' }; }
        if (name === 'pc') { return { value: symbolise(v), type: 'void (*)()' }; }
        if (name === 'lr' && this.spec.lrAsHex) { return { value: hex(v), type: 'void (*)()' }; }
        if (['sp', 'msp', 'psp', 'msp_s', 'psp_s', 'msp_ns', 'psp_ns'].includes(name)) { return { value: hex(v), type: 'void *' }; }
        return { value: String(v | 0), type: 'int' };
    }

    /** A wedged probe (#3): GDB still answers from its caches, but no memory read reaches the target. */
    readable(addr) { return !this.spec.wedged && READABLE.some(([lo, hi]) => addr >= lo && addr < hi); }
    byteAt(addr) { return ((this.words.get((addr - (addr & 3)) >>> 0) ?? 0) >>> ((addr & 3) * 8)) & 0xff; }
    readBytes(addr, count) {
        const out = [];
        for (let i = 0; i < count; i++) {
            const a = (addr + i) >>> 0;
            if (!this.readable(a)) { return null; }
            out.push(this.byteAt(a));
        }
        return Buffer.from(out);
    }
    /** What GDB's -data-read-memory-bytes reads of a range: one block per readable stretch, each where it begins. */
    readableBlocks(addr, count) {
        const blocks = [];
        let block = null;
        for (let i = 0; i < count; i++) {
            const a = (addr + i) >>> 0;
            if (!this.readable(a)) { block = null; continue; }
            if (!block) { block = { begin: a, bytes: [] }; blocks.push(block); }
            block.bytes.push(this.byteAt(a));
        }
        return blocks.map((b) => ({ begin: b.begin, bytes: Buffer.from(b.bytes) }));
    }
    writeBytes(addr, buf) {
        for (let i = 0; i < buf.length; i++) {
            const a = (addr + i) >>> 0;
            const base = (a - (a & 3)) >>> 0;
            const shift = (a & 3) * 8;
            const w = this.words.get(base) ?? 0;
            this.words.set(base, ((w & ~(0xff << shift)) | (buf[i] << shift)) >>> 0);
        }
    }

    /** What GDB's -var-create would make of `expression` in `ref`'s frame, or null when it fails. */
    varCreate(expression, ref) {
        const fnName = ref.frame.fn;
        const reg = /^\$([a-z0-9_]+)$/i.exec(expression);
        if (reg) { return this.naturalRegister(reg[1], this.regs(ref.threadId === 1 ? ref.level : 0)); }
        const deref = /^\*\(unsigned int\s*\*\)\s*(0x[0-9a-f]+)$/i.exec(expression);
        if (deref) {
            const buf = this.readBytes(Number(deref[1]), 4);
            return { value: buf ? String(buf.readUInt32LE(0)) : '', type: 'unsigned int' };
        }
        const local = LOCALS[fnName]?.[expression];
        const entry = local ?? GLOBALS[expression];
        if (!entry) { return null; }
        return { value: entry[0], type: entry[1], children: entry[2] };
    }

    answer(command, args) {
        if (this.failures[command]) {
            if (['next', 'stepIn', 'stepOut'].includes(command)) {
                const req = { next: 'nextRequest', stepIn: 'stepInRequest', stepOut: 'stepOutRequest' }[command];
                this.output('console', `Error occurred during the ${req}: ${this.failures[command]}\n`);
            }
            throw new Error(this.failures[command]);
        }
        switch (command) {
            case 'threads':
                return { threads: this.threadSet.map((t) => ({ id: t.id, name: t.name, running: this.state !== 'stopped' })) };
            case 'stackTrace': {
                if (this.state !== 'stopped') { throw new Error(RUNNING_MSG); }
                const frames = this.frames(args.threadId);
                if (!frames) { throw new Error(`Invalid thread id: ${args.threadId}`); }
                const depth = frames.length;
                const levels = args.levels ? Math.min(args.levels, depth) : depth;
                const low = args.startFrame || 0;
                const base = 1000 + (args.threadId - 1) * 100;
                const stackFrames = frames.slice(low, low + levels).map((f, i) => {
                    const file = this.sc.sourcePath(f.file);
                    return {
                        id: base + low + i, name: f.fn,
                        ...(file ? { source: { name: path.basename(file), path: file, sourceReference: 0 } } : {}),
                        line: f.line, column: 0, instructionPointerReference: hex(f.addr),
                    };
                });
                return { stackFrames, totalFrames: depth };
            }
            case 'scopes':
                return {
                    scopes: [
                        { name: 'Local', variablesReference: 2000 + (args.frameId - 1000) * 2, expensive: false },
                        { name: 'Registers', variablesReference: 2001 + (args.frameId - 1000) * 2, expensive: true },
                    ],
                };
            case 'variables': {
                const r = args.variablesReference;
                if (r >= 3000) { return { variables: this.children(r) }; }
                const ref = this.frameRef(1000 + Math.floor((r - 2000) / 2));
                if (!ref) { return { variables: [] }; }
                if ((r - 2000) % 2 === 1) {
                    const regs = this.regs(ref.level);
                    return { variables: REGISTER_ORDER.map((n) => ({ name: n, evaluateName: `$${n}`, value: hex(regs[n]), variablesReference: 0 })) };
                }
                return {
                    variables: Object.entries(LOCALS[ref.frame.fn] ?? {}).map(([name, [value, type, kids]], i) => ({
                        name, evaluateName: name, value, type, variablesReference: kids ? 3000 + i * 100 + ref.level : 0,
                    })),
                };
            }
            case 'evaluate':
                return this.evaluate(args);
            case 'readMemory': {
                if (this.spec.noReadMemory) { throw new Error('unrecognized request'); }
                const addr = Number(args.memoryReference) + (args.offset ?? 0);
                if (this.state !== 'stopped') { throw new Error(`${RUNNING_MSG} (@ ${hex(addr)})`); }
                if (!args.count) { return undefined; }
                // The Corstone FVP's GDB server answers System Control Space reads longer than one word with zeros.
                if (this.spec.zeroScsBlocks && args.count > 4 && addr >= 0xe000e000 && addr <= 0xe000efff) {
                    return { data: Buffer.alloc(args.count).toString('base64'), address: hex(addr) };
                }
                // cdt-gdb-adapter answers with GDB's first block and its begin, later than asked when the range starts in a hole.
                const [block] = this.readableBlocks(addr, args.count);
                if (!block) { throw new Error(`Unable to read memory. (@ ${hex(addr)})`); }
                return { data: block.bytes.toString('base64'), address: hex(block.begin) };
            }
            case 'writeMemory': {
                if (this.state !== 'stopped') { throw new Error(RUNNING_MSG); }
                const addr = Number(args.memoryReference);
                const buf = Buffer.from(args.data, 'base64');
                if (!this.readBytes(addr, buf.length)) { throw new Error(`Could not write memory at ${hex(addr)}`); }
                // A read-only register (`readOnly` addresses) ignores the write.
                if (!(this.spec.readOnly ?? []).includes(addr)) { this.writeBytes(addr, buf); }
                return undefined;
            }
            case 'next': case 'stepIn': case 'stepOut': case 'continue':
                if (this.state !== 'stopped') { throw new Error(RUNNING_MSG); }
                this.perform(command);
                return command === 'continue' ? { allThreadsContinued: true } : undefined;
            case 'pause':
                // An Arm FVP's GDB server ignores GDB's interrupt while the model runs (`ignoresPause`).
                if (this.state !== 'stopped' && !this.spec.ignoresPause) { setTimeout(() => this.stopAt(this.runningAt, 'SIGINT'), 5); }
                return undefined;
            default:
                throw new Error('unrecognized request');
        }
    }

    // ── GDB commands ('>' input) ──

    /** GDB refuses what needs the target while it runs; the breakpoint table can still be listed. */
    requireHalted(command) {
        if (this.state !== 'stopped' && !/^(-break-list|info breakpoints)\b/.test(command)) { throw new Error(RUNNING_MSG); }
    }

    /** A GDB/MI command: its result record as cdt-gdb-adapter hands it on, or GDB's error. */
    miCommand(cmd) {
        this.requireHalted(cmd);
        const [name, ...args] = miArguments(cmd);
        const done = (result) => ({ ...result, 'cdt-token': String(++this.miToken), 'cdt-command': cmd });
        switch (name) {
            case '-data-read-memory-bytes': {
                const addr = Number(args[0]);
                const count = Number(args[1]);
                const blocks = this.readableBlocks(addr, count);
                if (blocks.length === 0) { throw new Error('Unable to read memory.'); }
                return done({
                    memory: blocks.map((b) => ({
                        begin: hex(b.begin), offset: `0x${(b.begin - addr).toString(16).padStart(8, '0')}`,
                        end: hex(b.begin + b.bytes.length), contents: b.bytes.toString('hex'),
                    })),
                });
            }
            case '-dprintf-insert': {
                // Options (-t, -f, -d, -c COND, -i N, -p THREAD) come before the location.
                let cond;
                let at = 0;
                while (at < args.length && args[at].startsWith('-')) {
                    if (['-c', '-i', '-p'].includes(args[at])) { cond = args[at] === '-c' ? args[at + 1] : cond; at += 2; } else { at += 1; }
                }
                const [location, format, ...values] = args.slice(at);
                const bp = this.insertBreakpoint('dprintf', location, { format, values, cond });
                return done({ bkpt: this.miBreakpoint(bp) });
            }
            case '-break-list':
                return done({
                    BreakpointTable: {
                        nr_rows: String(this.gdbBreakpoints.length), nr_cols: '6',
                        hdr: ['Num', 'Type', 'Disp', 'Enb', 'Address', 'What'].map((colhdr) => ({ colhdr })),
                        body: this.gdbBreakpoints.map((bp) => this.miBreakpoint(bp)),
                    },
                });
            default:
                throw new Error(`Undefined MI command: ${name.slice(1)}`);
        }
    }

    /** A breakpoint as GDB/MI describes it. */
    miBreakpoint(bp) {
        const fullname = this.sc.sourcePath(bp.file);
        return {
            number: String(bp.number), type: bp.type, disp: 'keep', enabled: 'y', addr: `0x${bp.addr.toString(16).padStart(8, '0')}`,
            func: bp.fn, file: bp.file, fullname, line: String(bp.line), 'thread-groups': ['i1'],
            ...(bp.cond ? { cond: bp.cond } : {}), times: String(bp.hits),
            ...(bp.type === 'dprintf' ? { script: [`printf ${printfLiteral(bp.format)}${bp.values.map((v) => `,${v}`).join('')}`] } : {}),
            'original-location': bp.location,
        };
    }

    /** A new GDB breakpoint at a linespec (`file:line`, the file matched by its trailing path), or GDB's error. */
    insertBreakpoint(type, location, extra = {}) {
        const colon = location.lastIndexOf(':');
        const file = location.slice(0, colon);
        const line = Number(location.slice(colon + 1));
        const resolved = resolveSourceLine(file, line);
        if (!resolved) { throw new Error(`No source file named ${file}.`); }
        if (!resolved.where) { throw new Error(`No line ${line} in file "${resolved.name}".`); }
        const { where } = resolved;
        const bp = { number: this.nextBreakpoint++, type, file: resolved.name, line: where.line, addr: where.addr, fn: where.fn, location, hits: 0, ...extra };
        this.gdbBreakpoints.push(bp);
        return bp;
    }

    /** A GDB CLI command: its text goes out as stdout output events, a refusal throws GDB's error. */
    cliCommand(cmd) {
        this.requireHalted(cmd);
        const print = (text) => this.output('stdout', text);
        let hit;
        if (cmd === 'info registers') {
            const regs = this.regs(0);
            print(REGISTER_ORDER.map((n) => {
                const natural = n === 'pc' ? symbolise(regs[n]) : ['sp', 'msp', 'psp'].includes(n) ? hex(regs[n]) : String(regs[n] | 0);
                return `${n.padEnd(15)}${hex(regs[n]).padEnd(19)}${natural}`;
            }).join('\n') + '\n');
        } else if (cmd === 'info breakpoints') {
            const rows = this.gdbBreakpoints.map((bp) => `${String(bp.number).padEnd(8)}${bp.type.padEnd(15)}keep y   0x${bp.addr.toString(16).padStart(8, '0')} in ${bp.fn} at ${bp.file}:${bp.line}`
                + (bp.cond ? `\n\tstop only if ${bp.cond}` : '')
                + (bp.type === 'dprintf' ? `\n        printf ${printfLiteral(bp.format)}${bp.values.map((v) => `,${v}`).join('')}` : ''));
            print(rows.length > 0 ? `Num     Type           Disp Enb Address    What\n${rows.join('\n')}\n` : 'No breakpoints or watchpoints.\n');
        } else if ((hit = /^dprintf\s+([^,]+),"((?:[^"\\]|\\.)*)"(.*)$/.exec(cmd))) {
            const values = hit[3].split(',').map((v) => v.trim()).filter(Boolean);
            const bp = this.insertBreakpoint('dprintf', hit[1].trim(), { format: miArguments(`"${hit[2]}"`)[0], values });
            print(`Dprintf ${bp.number} at 0x${bp.addr.toString(16)}: file ${bp.file}, line ${bp.line}.\n`);
            // cdt-gdb-adapter announces a breakpoint GDB created from a CLI command.
            this.emit('breakpoint', { reason: 'new', breakpoint: { id: bp.number, verified: true, source: { name: bp.file, path: this.sc.sourcePath(bp.file) }, line: bp.line } });
        } else if ((hit = /^condition\s+(\d+)\s*(.*)$/.exec(cmd))) {
            const bp = this.gdbBreakpoints.find((b) => b.number === Number(hit[1]));
            if (!bp) { throw new Error(`No breakpoint number ${hit[1]}.`); }
            if (hit[2] && !this.knownExpression(hit[2])) { throw new Error(`No symbol "${hit[2].split(/\W+/)[0]}" in current context.`); }
            bp.cond = hit[2] || undefined;
            if (!hit[2]) { print(`Breakpoint ${bp.number} now unconditional.\n`); }
            this.emit('breakpoint', { reason: 'changed', breakpoint: { id: bp.number, verified: true, source: { name: bp.file, path: this.sc.sourcePath(bp.file) }, line: bp.line } });
        } else if ((hit = /^delete(?:\s+(.*))?$/.exec(cmd))) {
            const numbers = hit[1] ? hit[1].trim().split(/\s+/).map(Number) : this.gdbBreakpoints.map((b) => b.number);
            if (!hit[1]) { print('Delete all breakpoints, watchpoints, tracepoints, and catchpoints? (y or n) [answered Y; input not from terminal]\n'); }
            for (const number of numbers) {
                if (!this.gdbBreakpoints.some((b) => b.number === number)) {
                    print(`No breakpoint number ${number}.\n`);
                    continue;
                }
                this.gdbBreakpoints = this.gdbBreakpoints.filter((b) => b.number !== number);
                this.emit('breakpoint', { reason: 'removed', breakpoint: { id: number, verified: false } });
            }
        } else if ((hit = /^monitor\s+(.*)$/.exec(cmd))) {
            this.monitor(hit[1].trim(), print);
        } else if (cmd === 'maintenance flush register-cache') {
            if (this.resetAt) { this.at = this.resetAt; this.resetAt = null; }
            print('Register cache flushed.\n');
        } else if (cmd === 'maintenance flush dcache') {
            // Nothing to show.
        } else if ((hit = /^set\s+\{unsigned int\}\s*(0x[0-9a-f]+)\s*=\s*(\d+)$/i.exec(cmd))) {
            const addr = Number(hit[1]);
            if (!this.readBytes(addr, 4)) { throw new Error(`Cannot access memory at address ${hex(addr)}`); }
            const buf = Buffer.alloc(4);
            buf.writeUInt32LE(Number(hit[2]) >>> 0, 0);
            this.writeBytes(addr, buf);
        } else if ((hit = /^x\/1xw\s+(0x[0-9a-f]+)$/i.exec(cmd))) {
            const buf = this.readBytes(Number(hit[1]), 4);
            if (!buf) { throw new Error(`Cannot access memory at address ${hit[1]}`); }
            print(`${hit[1]}:\t0x${buf.readUInt32LE(0).toString(16).padStart(8, '0')}\n`);
        } else if ((hit = /^print(?:\/x)?\s+(.*)$/.exec(cmd))) {
            const ref = this.frameRef(1000);
            const v = ref ? this.varCreate(hit[1].trim(), ref) : null;
            if (!v) { throw new Error(`No symbol "${hit[1].trim()}" in current context.`); }
            const shown = cmd.startsWith('print/x') && /^-?\d+$/.test(v.value) ? hex(Number(v.value)) : v.value;
            print(`$${++this.valueHistory} = ${shown}\n`);
        } else {
            throw new Error(`Undefined command: "${cmd.split(/\s+/)[0]}".  Try "help".`);
        }
    }

    /** Whether `expression` names only symbols GDB knows at the stop (for a condition). */
    knownExpression(expression) {
        const ref = this.frameRef(1000);
        const names = expression.match(/[A-Za-z_]\w*/g) ?? [];
        return names.every((name) => GLOBALS[name] || (ref && LOCALS[ref.frame.fn]?.[name]));
    }

    /** A monitor command as the GDB server behind the session answers it. */
    monitor(command, print) {
        const jlink = this.spec.config === 'jlink';
        let reset;
        if (jlink) {
            if (command === 'halt') { return; }
            // J-Link's Cortex-M reset strategies: 0 normal, 1 core, 2 reset pin.
            reset = /^reset\s+[012]$/.test(command);
            if (reset) { print('Resetting target\n'); }
        } else {
            reset = /^reset\s+halt\s+(system|core|hardware)$/.exec(command);
            if (reset) { print('Resetting target with halt\nSuccessfully halted device on reset\n'); }
        }
        if (!reset) {
            print(jlink ? `Unknown monitor command: ${command}\n` : `Error: No command named '${command.split(' ')[0]}'\n`);
            return;
        }
        // The core now sits at the reset vector; GDB does not know until its register cache is flushed.
        this.resetAt = 'resetHandler';
    }

    /** VS Code's `setBreakpoints` for one file of its model, answered as cdt-gdb-adapter answers it. */
    setBreakpointsFromVsCode(fsPath) {
        if (this.dead || this.hung) { return; }
        const name = path.basename(fsPath);
        const requested = stub.debug.breakpoints.filter((bp) => bp instanceof stub.SourceBreakpoint && bp.location.uri.fsPath === fsPath);
        const seq = 5000 + this.seq++;
        this.tracker?.receive({
            type: 'request', seq, command: 'setBreakpoints',
            arguments: {
                source: { name, path: fsPath },
                breakpoints: requested.map((bp) => ({ line: bp.location.range.start.line + 1, condition: bp.condition, logMessage: bp.logMessage })),
            },
        });
        // The file's GDB breakpoints are those whose location names it; VS Code's list replaces them.
        const inFile = this.gdbBreakpoints.filter((bp) => bp.location.includes(`-source ${fsPath} -line `) || bp.location.includes(fsPath));
        const kept = new Set();
        const answers = requested.map((vsbp) => {
            const line = vsbp.location.range.start.line + 1;
            // cdt-gdb-adapter matches on the line, the condition and hardware or not; never on the type.
            const match = inFile.find((bp) => !kept.has(bp) && /(?:-line |:)(\d+)$/.exec(bp.location)?.[1] === String(line)
                && (bp.cond || undefined) === (vsbp.condition || undefined));
            if (match) {
                kept.add(match);
                return { id: match.number, line: match.line, verified: true };
            }
            try {
                const bp = this.insertBreakpoint('breakpoint', `${fsPath}:${line}`, { cond: vsbp.condition || undefined });
                bp.location = `-source ${fsPath} -line ${line}`;
                kept.add(bp);
                return { id: bp.number, line: bp.line, verified: true };
            } catch (err) {
                return { verified: false, message: err.message };
            }
        });
        const deleted = inFile.filter((bp) => !kept.has(bp)).map((bp) => bp.number);
        this.gdbBreakpoints = this.gdbBreakpoints.filter((bp) => !deleted.includes(bp.number));
        requested.forEach((bp, i) => this.bindings.set(bp, answers[i]));
        const shown = requested.map((bp, i) => {
            const a = answers[i];
            const line = bp.location.range.start.line + 1;
            return a.verified ? `${line} → #${a.id}${a.line !== line ? ` line ${a.line}` : ''}` : `${line} → ${a.message}`;
        });
        this.sc.record(`vscode: setBreakpoints ${name} [${shown.join(', ')}]${deleted.length ? ` (deleted #${deleted.join(', #')})` : ''}`);
        this.tracker?.send({ type: 'response', request_seq: seq, command: 'setBreakpoints', success: true, body: { breakpoints: answers } });
    }

    children(ref) {
        const varobj = this.varobjChildren.get(ref);
        if (varobj) {
            return varobj.map(([name, value, type, kids]) => ({ name, evaluateName: name, value, type, variablesReference: this.varobjReference(kids) }));
        }
        const level = ref % 100;
        const index = Math.floor((ref - 3000) / 100);
        const fn = LOCATIONS[this.at]?.[level]?.fn;
        const entry = Object.values(LOCALS[fn] ?? {})[index];
        return (entry?.[2] ?? []).map(([name, value, type]) => ({ name, evaluateName: name, value, type, variablesReference: 0 }));
    }

    evaluate(args) {
        const notEvaluated = { result: NOT_EVALUATED, variablesReference: 0 };
        const expression = String(args.expression).trim();
        const isCli = expression.startsWith('>') && args.context === 'repl';
        if (!isCli && args.frameId === undefined) { throw new Error('Evaluation of expression without frameId is not supported.'); }
        const ref = this.frameRef(args.frameId);
        if (!isCli && !ref) { return notEvaluated; }
        if (isCli) {
            const cmd = expression.slice(1).trim();
            if (cmd.startsWith('-')) {
                return { result: JSON.stringify(this.miCommand(cmd)), variablesReference: 0 };
            }
            // A CLI command's text goes to the Debug Console as stdout; the reply carries none of it.
            this.cliCommand(cmd);
            return { result: '\r', variablesReference: 0 };
        }
        const fmt = /,([a-z])$/i.exec(expression);
        const base = fmt ? expression.slice(0, -2).trim() : expression;
        if (fmt && !'xdotbz'.includes(fmt[1])) { throw new Error('Unknown expression format specifier, supported specifiers are: x, d, o, b, t, z'); }
        const v = this.varCreate(base, ref);
        if (!v) { return notEvaluated; }
        let result = v.value;
        if (fmt && fmt[1] === 'x' && /^-?\d+$/.test(v.value)) { result = hex(Number(v.value)); }
        return { result, type: v.type, variablesReference: this.varobjReference(v.children) };
    }
}

// ── Scenario context ───────────────────────────────────────────────────────

function sessionConfig(env, kind) {
    const project = env.project;
    const common = {
        type: 'gdbtarget',
        cwd: project,
        program: path.join(project, 'out', 'Blinky', 'NUCLEO-F401RE', 'Debug', 'Blinky.elf'),
        gdb: 'arm-none-eabi-gdb',
        cmsis: { cbuildRunFile: env.cbuildRun },
    };
    switch (kind) {
        case 'pyocd':
            return { ...common, name: 'CMSIS Debugger: pyOCD', request: 'launch', initCommands: ['load', 'break main'],
                target: { server: 'pyocd', port: '3333' } };
        case 'pyocd-attach':
            return { ...common, name: 'CMSIS Debugger: pyOCD (attach)', request: 'attach',
                target: { server: 'pyocd', port: '3333' } };
        case 'fvp':
            return { ...common, name: 'Arm-FVP@GDB (launch)', request: 'launch', initCommands: ['tbreak main'],
                target: { server: path.join(project, '.vscode', 'fvp.sh'), port: '',
                    serverParameters: ['-D', '--plugin', '/opt/fvp/plugins/GDBServer.so', '-C', 'GDBServer.port=3333', '-f', 'fvp_config.txt'] } };
        case 'jlink':
            return { ...common, name: 'CMSIS Debugger: J-LINK', request: 'launch', initCommands: ['load', 'break main'],
                target: { server: 'JLinkGDBServer', serverParameters: ['-device', 'STM32F401RE', '-endian', 'little',
                    '-if', 'SWD', '-speed', 'auto', '-noir', '-vd', '-nogui', '-localhostonly', '-port', '3333'], port: '3333' } };
        default:
            throw new Error(`unknown session kind ${kind}`);
    }
}

const DEFAULT_COMMANDS = {
    'cmsis-csolution.getSolutionFile': (sc) => path.join(sc.env.project, 'Blinky.csolution.yml'),
    'cmsis-csolution.getActiveTargetSet': () => 'NUCLEO-F401RE',
    'cmsis-csolution.getPackRootPath': (sc) => sc.env.packRoot,
};

class ScenarioContext {
    constructor(def, index, env) {
        this.def = def;
        this.index = index;
        this.env = env;
        this.log = [];
        this.targets = [];
        this.sessionCount = 0;
        this.commands = { ...DEFAULT_COMMANDS, ...(def.commands ?? {}) };
    }

    record(line) { this.log.push(line); }

    sourcePath(file) {
        if (!file) { return null; }
        if (file.startsWith('@packs/')) { return path.join(this.env.packRoot, file.slice(7)); }
        return path.join(this.env.project, file);
    }

    get target() { return this.targets[this.targets.length - 1]; }

    /**
     * Bring a fake session up the way VS Code would; `spec.initial` is a stop, 'running', or nothing. With
     * `spec.connectMs` the adapter takes no requests for that long while GDB connects; then it answers the start
     * and VS Code configures the session, or, with `spec.connectFails` (GDB's error), the start fails.
     */
    launch(spec) {
        const config = sessionConfig(this.env, spec.config ?? 'pyocd');
        const session = {
            id: `scenario-${this.index + 1}-session-${++this.sessionCount}`,
            type: config.type,
            name: config.name,
            configuration: config,
            workspaceFolder: stub.workspace.workspaceFolders[0],
            customRequest: (command, args) => target.request(command, args),
            getDebugProtocolBreakpoint: async (bp) => target.bindings.get(bp),
        };
        const target = new FakeTarget(this, spec, session);
        this.targets.push(target);
        target.attachTracker();
        if (!spec.focusElsewhere) {
            stub.debug.activeDebugSession = session;
            bus.didChangeActiveSession.fire(session);
        }
        bus.didStart.fire(session);
        if (spec.connectMs) {
            target.ready = false;
            setTimeout(() => this.connect(target, spec), spec.connectMs);
            return session;
        }
        this.configure(target, spec);
        return session;
    }

    /** The connect ends: the adapter announces itself and answers the start, or answers it with GDB's error. */
    connect(target, spec) {
        if (target.dead) { return; }
        const request = target.session.configuration.request;
        if (spec.connectFails) {
            this.record(`adapter: response ${request} -> error: ${JSON.stringify(spec.connectFails)}`);
            target.tracker.send({ type: 'response', command: request, success: false, message: spec.connectFails,
                body: { error: { id: 1, format: spec.connectFails } } });
            this.endSession(target.session, { quiet: true });
            return;
        }
        target.ready = true;
        target.emit('initialized', {});
        this.record(`adapter: response ${request} -> success`);
        target.tracker.send({ type: 'response', command: request, success: true });
        this.configure(target, spec);
    }

    /** VS Code configures the session: its breakpoints, configurationDone, then the initial stop or run. */
    configure(target, spec) {
        // VS Code sends its breakpoints while the adapter configures the session.
        this.syncBreakpoints(stub.debug.breakpoints);
        // cdt-gdb-adapter prints this at configurationDone, which a failed launch never reaches.
        if (spec.banner !== false) { target.output('console', GDB_BANNER); }
        // The GDB server's output as some servers write it, a few characters per output event (`serverPieces`).
        for (const piece of spec.serverPieces ?? []) { target.output('server', piece); }
        if (spec.initial === 'running') {
            target.stopAt('main31', 'breakpoint');
            target.run();
        } else if (spec.initial && spec.initialDelayMs) {
            target.state = 'running';
            target.scheduleStop(spec.initialDelayMs, spec.initial.at, spec.initial.reason);
        } else if (spec.initial) {
            target.stopAt(spec.initial.at, spec.initial.reason);
        }
        if (spec.hangAfterStart) { target.hung = true; }
    }

    /** VS Code sends `setBreakpoints` for each file of these breakpoints to the live session a moment later. */
    syncBreakpoints(bps) {
        const target = this.target;
        const files = [...new Set(bps.filter((bp) => bp instanceof stub.SourceBreakpoint).map((bp) => bp.location.uri.fsPath))];
        // Only to an adapter that takes requests: VS Code sends them once the adapter has announced itself.
        if (!target || target.dead || !target.ready || files.length === 0) { return; }
        setTimeout(() => { for (const file of files) { target.setBreakpointsFromVsCode(file); } }, 2);
    }

    /** vscode.debug.startDebugging: the scenario's `launches` say what each configuration does. */
    startDebugging(name) {
        const plan = this.def.launches?.[name];
        if (!plan) { return false; }
        if (plan.fail) {
            const session = this.launch({ config: plan.config, banner: false });
            const target = this.target;
            for (const [category, text] of plan.fail.output) { target.output(category, text); }
            this.record(`adapter: response launch -> error: ${JSON.stringify(plan.fail.message)}`);
            target.tracker.send({ type: 'response', command: 'launch', success: false, message: plan.fail.message });
            target.emit('terminated', {});
            this.endSession(session, { quiet: true });
            return false;
        }
        this.launch(plan);
        return true;
    }

    /**
     * The first stop of a running target whose adapter halts it before it disconnects (`disconnectWaitsForHalt`, an Arm FVP
     * that ignores the halt): the disconnect goes to the adapter, which takes no requests from then on and never ends the
     * session; VS Code's second stop ends it.
     */
    holdsStop(session) {
        const target = this.targets.find((t) => t.session === session);
        if (!target || target.dead || !target.spec.disconnectWaitsForHalt || target.state !== 'running' || target.disconnecting) { return false; }
        target.disconnecting = true;
        target.tracker.receive({ type: 'request', seq: target.seq++, command: 'disconnect', arguments: { restart: false } });
        this.record('adapter: disconnect waits for a halt the target never reports');
        target.ready = false;
        return true;
    }

    endSession(session, { quiet = false } = {}) {
        const target = this.targets.find((t) => t.session === session);
        if (!target || target.dead) { return; }
        target.tracker.willStop();
        if (!quiet) { target.emit('terminated', {}); }
        target.dead = true;
        if (stub.debug.activeDebugSession === session) {
            stub.debug.activeDebugSession = undefined;
            stub.debug.activeStackItem = undefined;
            bus.didChangeStackItem.fire(undefined);
            bus.didChangeActiveSession.fire(undefined);
        }
        bus.didTerminate.fire(session);
    }

    /** Resolve '@file' arguments to project paths. */
    resolveArgs(args) {
        const out = {};
        for (const [k, v] of Object.entries(args)) {
            out[k] = typeof v === 'string' && v.startsWith('@') ? path.join(this.env.project, v.slice(1)) : v;
        }
        return out;
    }

    teardown() {
        for (const t of this.targets) {
            if (!t.dead) {
                const recording = this.log;
                this.log = [];
                this.endSession(t.session);
                this.log = recording;
            }
        }
    }
}

// ── Scenarios ──────────────────────────────────────────────────────────────

const RUNNING_RACE = { next: RUNNING_MSG };

const SCENARIOS = [
    {
        name: 'status-halted',
        description: 'pyOCD launch halted at a breakpoint in main: status, connection probe, device info.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'check_target_connection' },
            { tool: 'get_device_info' },
        ],
    },
    {
        name: 'call-stack-and-threads',
        description: 'RTX5 target with three threads, halted in led_toggle: call stacks (default, levels, other thread, deep thread) and thread list.',
        session: { initial: { at: 'ledToggle18', reason: 'breakpoint' }, threads: 'rtx' },
        calls: [
            { tool: 'get_call_stack' },
            { tool: 'get_call_stack', args: { levels: 1 } },
            { tool: 'get_call_stack', args: { threadId: 2 } },
            { tool: 'get_call_stack', args: { threadId: 3 } },
            { tool: 'get_call_stack', args: { threadId: 9 } },
            { tool: 'get_threads' },
        ],
    },
    {
        name: 'variables',
        description: 'Halted in led_toggle (caller main has a struct, arrays and secret-named locals): the adapter has Local and Registers scopes only, '
            + 'Registers marked expensive, so a listing reads Local alone and names Registers as not read.',
        session: { initial: { at: 'ledToggle18', reason: 'breakpoint' } },
        calls: [
            { tool: 'list_variable_names' },
            { tool: 'list_variable_names', args: { scope: 'local' } },
            { tool: 'get_variables_values' },
            { tool: 'get_variables_values', args: { variableNames: ['mask', 'counter'] } },
            { tool: 'get_variables_values', args: { variableNames: ['counter'] } },
            { tool: 'get_variables_values', args: { scope: 'global' } },
            { tool: 'get_frame_variables', args: { frameId: 1001 } },
            { tool: 'get_frame_variables', args: { frameId: 1001, variableNames: ['config', 'password', 'api_key'] } },
            { tool: 'get_frame_variables', args: { frameId: 1001, scope: 'local', variableNames: ['nosuch'] } },
            { tool: 'get_frame_variables', args: { frameId: 1077 } },
        ],
    },
    {
        name: 'evaluate',
        description: 'Halted in main: symbols, arithmetic, format suffix, struct with its fields, secret-named pointer and array (no fields), unknown symbol, a nested struct one and two levels deep (an array cut at 32 elements, a credential-named field withheld), and the GDB passthrough both ways: -exec is sent as the adapter\'s > and > as it is; the text GDB printed as stdout output comes back as the result.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'evaluate_expression', args: { expression: 'SystemCoreClock' } },
            { tool: 'evaluate_expression', args: { expression: 'counter * 2' } },
            { tool: 'evaluate_expression', args: { expression: 'counter,x' } },
            { tool: 'evaluate_expression', args: { expression: 'config' } },
            { tool: 'evaluate_expression', args: { expression: 'password' } },
            { tool: 'evaluate_expression', args: { expression: 'api_key' } },
            { tool: 'evaluate_expression', args: { expression: 'nosuch_symbol' } },
            { tool: 'evaluate_expression', args: { expression: '-exec info registers' } },
            { tool: 'evaluate_expression', args: { expression: '>info registers' } },
            { tool: 'evaluate_expression', args: { expression: '$pc' } },
            { tool: 'evaluate_expression', args: { expression: 'sensor' } },
            { tool: 'evaluate_expression', args: { expression: 'sensor', depth: 2 } },
        ],
    },
    {
        name: 'read-memory',
        description: 'Halted: DAP readMemory in hex / ascii / both, an address without 0x, an unmapped address where readMemory fails and every GDB fallback fails too, '
            + 'and ranges across the start and the end of SRAM: the adapter returns the mapped part from where it begins, and the dump says which part could not be read.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'read_memory', args: { address: '0x20000000', length: 16 } },
            { tool: 'read_memory', args: { address: '20000000', length: 20, format: 'ascii' } },
            { tool: 'read_memory', args: { address: '0x20000000', length: 70, format: 'both' } },
            { tool: 'read_memory', args: { address: '0x60000000', length: 8 } },
            { tool: 'read_memory', args: { address: '0x1FFFFFF0', length: 64, format: 'both' } },
            { tool: 'read_memory', args: { address: '0x20017FF0', length: 64 } },
        ],
    },
    {
        name: 'read-memory-gdb-fallback',
        description: 'An adapter without readMemory ("unrecognized request"): the executor falls back to one watch-context evaluate per word and trims to the length.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, noReadMemory: true },
        calls: [
            { tool: 'read_memory', args: { address: '0x20000010', length: 6, format: 'both' } },
        ],
    },
    {
        name: 'core-registers',
        description: 'Halted in main: every core register through a watch-context $reg evaluate.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'read_core_registers' },
        ],
    },
    {
        name: 'peripheral-registers',
        description: 'Halted; the SVD comes from the session\'s cbuild-run file (${CMSIS_PACK_ROOT} expanded): one register with fields, a whole (derived) peripheral, unknown names, and the target-free lookups through the same SVD.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'read_peripheral_register', args: { peripheral: 'RCC', register: 'CR' } },
            { tool: 'read_peripheral_register', args: { peripheral: 'usart2', register: 'sr' } },
            { tool: 'read_peripheral_register', args: { peripheral: 'GPIOB' } },
            { tool: 'read_peripheral_register', args: { peripheral: 'RCC', register: 'CRX' } },
            { tool: 'read_peripheral_register', args: { peripheral: 'UART2' } },
            { tool: 'lookup_register', args: { peripheral: 'USART2', register: 'CR1' } },
            { tool: 'lookup_peripheral', args: { address: '0x40004404' } },
        ],
    },
    {
        name: 'cycle-counter',
        description: 'Halted, trace disabled: the first read enables DEMCR.TRCENA and CYCCNTENA (write + read-back), the second finds them on.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'read_cycle_counter' },
            { tool: 'read_cycle_counter' },
        ],
    },
    {
        name: 'cycle-counter-absent',
        description: 'An Armv7-M core whose DWT_CTRL reports NOCYCCNT (bit 25): two comparators, no trace packets, no cycle or profiling counters.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, memory: { 0xe0001000: 0x2b000000, 0xe000edfc: 0x01000000 } },
        calls: [
            { tool: 'read_cycle_counter' },
        ],
    },
    {
        name: 'cycle-counter-one-comparator',
        description: 'DWT_CTRL 0x10000000: one comparator (NUMCOMP, bits 31:28) and a cycle counter, which the read enables.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, memory: { 0xe0001000: 0x10000000, 0xe000edfc: 0x01000000 } },
        calls: [
            { tool: 'read_cycle_counter' },
        ],
    },
    {
        name: 'cycle-counter-armv6m',
        description: 'A Cortex-M0+ (CPUID 0x410CC601): Armv6-M has no cycle counter, and its read-only DWT_CTRL holds NUMCOMP alone. Nothing is written.',
        session: {
            initial: { at: 'main31', reason: 'breakpoint' },
            memory: { 0xe000ed00: 0x410cc601, 0xe0001000: 0x20000000, 0xe0001004: 0 },
            readOnly: [0xe0001000],
        },
        calls: [
            { tool: 'read_cycle_counter' },
        ],
    },
    {
        name: 'fault-hardfault',
        description: 'Precise bus fault escalated to HardFault (CFSR=0x00008200, BFAR=0x60000000), halted by vector catch (SIGSEGV). LR reads "-7" as GDB prints an int register.',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, memory: FAULT_WORDS },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'get_call_stack' },
            { tool: 'get_fault_info' },
            { tool: 'diagnose_fault' },
            { tool: 'read_core_registers' },
        ],
    },
    {
        name: 'fault-diagnose-lr-hex',
        description: 'Same fault, but the adapter reports LR as a hex code pointer, so diagnose_fault reads the stacked exception frame at MSP.',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, memory: FAULT_WORDS, lrAsHex: true },
        calls: [
            { tool: 'diagnose_fault', args: { levels: 4 } },
        ],
    },
    {
        name: 'fault-trustzone-secure-stack',
        description: 'A BusFault in Secure code taken to the Non-secure HardFault handler (TrustZone, AIRCR.BFHFNMINS=1): EXC_RETURN 0xfffffff8 puts '
            + 'the frame on a Secure stack behind the integrity signature and R4–R11, CONTROL_S picks the process stack, so diagnose_fault reads PSP_S, '
            + 'not the Non-secure MSP.',
        session: { initial: { at: 'hardFaultFromSecure', reason: 'SIGSEGV' }, memory: { ...FAULT_WORDS, ...SECURE_FRAME_WORDS }, lrAsHex: true },
        calls: [
            { tool: 'diagnose_fault' },
        ],
    },
    {
        name: 'fault-lockup',
        description: 'The same fault, with the core in lockup (DHCSR.S_LOCKUP): get_fault_info and diagnose_fault say so (#3).',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, memory: { ...FAULT_WORDS, 0xe000edf0: 0x000b0003 } },
        calls: [
            { tool: 'get_fault_info' },
            { tool: 'diagnose_fault' },
        ],
    },
    {
        name: 'fault-scs-word-reads',
        description: 'The same fault on a GDB server that answers System Control Space reads longer than one word with zeros, as the Corstone FVP\'s does: '
            + 'the fault registers and a read_memory there are read one word each, so the fault shows.',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, memory: FAULT_WORDS, zeroScsBlocks: true },
        calls: [
            { tool: 'get_fault_info' },
            { tool: 'diagnose_fault' },
            { tool: 'read_memory', args: { address: '0xE000ED28', length: 8 } },
        ],
    },
    {
        name: 'fault-status-clear-in-handler',
        description: 'Halted in the HardFault handler (IPSR 3) with CFSR and HFSR clear: diagnose_fault does not say the target is not in a fault.',
        session: { initial: { at: 'hardFault', reason: 'breakpoint' } },
        calls: [
            { tool: 'diagnose_fault' },
        ],
    },
    {
        name: 'probe-wedged',
        description: 'Halted in HardFault, then the probe wedges (#3): GDB answers threads, stack and registers from its caches, but every memory read '
            + 'fails, DHCSR included. The fault tools and read_memory answer PROBE_WEDGED with each strategy\'s cause and the hint of a launch session. '
            + 'Afterwards get_session_status names the DHCSR read that got no answer without reading, and check_target_connection reads DHCSR again.',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, memory: FAULT_WORDS, wedged: true },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'get_fault_info' },
            { tool: 'diagnose_fault' },
            { tool: 'read_memory', args: { address: '0x20017fa8', length: 32 } },
            { tool: 'get_session_status' },
            { tool: 'check_target_connection' },
        ],
    },
    {
        name: 'probe-wedged-attach',
        description: 'The same wedge in a pyOCD attach session: the hint reconnects with cmsis_action detach and attach (#3).',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, memory: FAULT_WORDS, wedged: true, config: 'pyocd-attach' },
        calls: [
            { tool: 'get_fault_info' },
        ],
    },
    {
        name: 'execution-steps',
        description: 'Step into led_toggle, over, out, over, continue to the breakpoint; then wait_for_stop and pause_execution on the stopped target.',
        session: {
            initial: { at: 'main31', reason: 'breakpoint' },
            stops: [
                { on: 'stepIn', at: 'ledToggle17', reason: 'step' },
                { on: 'next', at: 'ledToggle18', reason: 'step' },
                { on: 'stepOut', at: 'main32', reason: 'step' },
                { on: 'next', at: 'main29', reason: 'step' },
                { on: 'continue', at: 'main31', reason: 'breakpoint', delayMs: 50 },
            ],
        },
        calls: [
            { tool: 'step_into' },
            { tool: 'step_over' },
            { tool: 'step_out' },
            { tool: 'step_over' },
            { tool: 'continue_execution' },
            { tool: 'wait_for_stop' },
            { tool: 'pause_execution' },
        ],
    },
    {
        name: 'fvp-ignores-pause',
        description: 'An Arm FVP, whose GDB server ignores GDB\'s interrupt while the model runs: a continue that does not stop, a pause and a '
            + 'breakpoint change on the running model say that only a breakpoint stops it, and how to set one, instead of advising a pause.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, config: 'fvp', ignoresPause: true },
        calls: [
            { tool: 'continue_execution', args: { timeoutMs: 300 } },
            { tool: 'pause_execution', args: { timeoutMs: 1000 } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 29 } },
        ],
    },
    {
        name: 'fvp-stop-waits-for-halt',
        description: 'stop_debugging on a running Arm FVP: the adapter halts the target before it disconnects and the model ignores the halt, so '
            + 'the first stop answers timeout and says to stop again, the status says the session is shutting down rather than starting, '
            + 'and the second stop ends it.',
        session: { initial: 'running', config: 'fvp', ignoresPause: true, disconnectWaitsForHalt: true },
        calls: [
            { tool: 'stop_debugging' },
            { tool: 'get_session_status' },
            { tool: 'stop_debugging' },
        ],
    },
    {
        name: 'step-ui-fallback',
        description: 'The tracker says stopped but the adapter rejects `next` with GDB\'s running-target error: on gdbtarget the step answers TARGET_RUNNING and no UI command runs (the scripted UI command would step).',
        session: {
            initial: { at: 'main31', reason: 'breakpoint' },
            failures: RUNNING_RACE,
            stops: [{ on: 'ui:next', at: 'main32', reason: 'step' }],
        },
        commands: {
            'workbench.action.debug.stepOver': (sc) => {
                sc.record('adapter: next (sent by the VS Code UI, succeeds)');
                sc.target.perform('ui:next');
            },
        },
        calls: [
            { tool: 'step_over' },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'continue-timeout-recovery',
        description: 'continue_execution with timeoutMs 600 and no breakpoint on the path: status running, the target is left running (no pause); '
            + 'pause_execution stops it in delay_ms; a step_over that does not stop within 600 ms gets the recovery pause, which reports PC/LR.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, runningAt: 'delayLoop' },
        calls: [
            { tool: 'continue_execution', args: { timeoutMs: 600 } },
            { tool: 'get_session_status' },
            { tool: 'pause_execution' },
            { tool: 'step_over', args: { timeoutMs: 600 } },
        ],
    },
    {
        name: 'running-target',
        description: 'Target running (continued event seen): inspection is refused (as text or as an error), then pause_execution halts it in delay_ms and inspection works.',
        session: { initial: 'running', runningAt: 'delayLoop' },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'check_target_connection' },
            { tool: 'read_memory', args: { address: '0x20000000', length: 16 } },
            { tool: 'get_variables_values' },
            { tool: 'evaluate_expression', args: { expression: 'counter' } },
            { tool: 'get_call_stack' },
            { tool: 'step_over' },
            { tool: 'wait_for_stop', args: { timeoutMs: 100 } },
            { tool: 'pause_execution' },
            { tool: 'read_memory', args: { address: '0x20000010', length: 4 } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'wait-for-stop',
        description: 'Running target that hits a breakpoint 500 ms into wait_for_stop; a second wait_for_stop finds it already stopped.',
        session: { initial: 'running' },
        calls: [
            { tool: 'wait_for_stop', args: { timeoutMs: 5000 }, before: (sc) => sc.target.scheduleStop(500, 'main31', 'breakpoint') },
            { tool: 'wait_for_stop' },
        ],
    },
    {
        name: 'wait-for-stop-timeout',
        description: 'Running target that never stops: wait_for_stop with timeoutMs 2000 (budget 500 ms) times out.',
        session: { initial: 'running' },
        calls: [
            { tool: 'wait_for_stop', args: { timeoutMs: 2000 } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'breakpoints',
        description: 'Halted in main: breakpoints go to the VS Code model, VS Code sends them to the adapter and the answer reports its binding; logpoints become GDB dprintfs through MI -dprintf-insert (a condition through `condition N`), remembered and deleted by number; steps show the breakpoint list diff.',
        session: {
            initial: { at: 'main31', reason: 'breakpoint' },
            stops: [{ on: 'next', at: 'main32', reason: 'step' }, { on: 'next', at: 'main29', reason: 'step' }],
        },
        calls: [
            { tool: 'list_breakpoints' },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 29 } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 30, condition: 'counter > 10' } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', lineContent: 'counter' } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', lineContent: 'no such text' } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c' } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 32, logMessage: 'counter={counter} led={ledState:%u} 100%' } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 33, logMessage: 'tick', condition: 'counter % 100 == 0' } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 34, logMessage: 'broken {counter' } },
            { tool: 'list_breakpoints' },
            { tool: 'step_over' },
            { tool: 'step_over' },
            { tool: 'remove_breakpoint', args: { fileFullPath: '@main.c', line: 29 } },
            { tool: 'remove_breakpoint', args: { fileFullPath: '@main.c', line: 99 } },
            { tool: 'clear_all_breakpoints' },
            { tool: 'list_breakpoints' },
        ],
    },
    {
        name: 'reset-verified',
        description: 'pyOCD, halted at Reset_Handler: `monitor reset halt system` reaches GDB with `>` and pyOCD\'s text comes back; GDB\'s caches are flushed and PC equals the reset vector.',
        session: { initial: { at: 'resetHandler', reason: 'breakpoint' } },
        calls: [
            { tool: 'reset', args: { method: 'system' } },
        ],
    },
    {
        name: 'reset-not-verified-jlink',
        description: 'J-Link, target running, reset with halt=false and the default auto method: pause first; `monitor halt` and `monitor reset 0` reach GDB, the cache flush shows the core at the reset vector, the first method verifies and the target is resumed.',
        session: { config: 'jlink', initial: 'running', runningAt: 'delayLoop' },
        calls: [
            { tool: 'reset', args: { halt: false } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'reset-hardware-jlink',
        description: 'J-Link, halted in main, reset with method hardware: `monitor halt` and `monitor reset 2`, J-Link\'s reset-pin strategy, reach GDB; the cache flush shows the core at the reset vector and the reset verifies.',
        session: { config: 'jlink', initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'reset', args: { method: 'hardware' } },
        ],
    },
    {
        name: 'restart-and-stop',
        description: 'restart_debugging on a halted gdbtarget session stops it and starts its launch configuration again through the debug API (the new session stops at main 500 ms later), then stop_debugging ends it.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        launches: { 'CMSIS Debugger: pyOCD': { config: 'pyocd', initial: { at: 'main31', reason: 'breakpoint' }, initialDelayMs: 500 } },
        calls: [
            { tool: 'restart_debugging', settleMs: 800 },
            { tool: 'get_session_status' },
            { tool: 'stop_debugging' },
            { tool: 'get_session_status' },
            { tool: 'stop_debugging' },
        ],
    },
    {
        name: 'restart-running',
        description: 'restart_debugging while the gdbtarget target runs: it is paused first, then the session is stopped and its launch configuration started again (the model breakpoint is sent to the new session).',
        session: { initial: 'running', runningAt: 'delayLoop' },
        launches: { 'CMSIS Debugger: pyOCD': { config: 'pyocd', initial: { at: 'main31', reason: 'breakpoint' }, initialDelayMs: 300 } },
        calls: [
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 31 } },
            { tool: 'restart_debugging', settleMs: 600 },
            { tool: 'get_session_status' },
            { tool: 'list_breakpoints' },
        ],
    },
    {
        name: 'breakpoint-running-target',
        description: 'Target running in delay_ms: each breakpoint change pauses it, applies the change (VS Code\'s setBreakpoints, or GDB\'s dprintf and delete) and resumes it, and the answer says so.',
        session: { initial: 'running', runningAt: 'delayLoop' },
        calls: [
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 31 } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 32, logMessage: 'counter={counter}' } },
            { tool: 'get_session_status' },
            { tool: 'list_breakpoints' },
            { tool: 'remove_breakpoint', args: { fileFullPath: '@main.c', line: 31 } },
            { tool: 'clear_all_breakpoints' },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'logpoint-dprintf',
        description: 'Halted in main: logpoints are GDB dprintfs at a workspace-relative location, remembered by number; a model breakpoint in the same file leaves them alone; one is deleted by remove_breakpoint, one by an agent\'s own `-exec delete` (the adapter\'s breakpoint event makes the tools forget it); they end with the session.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        launches: { 'CMSIS Debugger: pyOCD': { config: 'pyocd', initial: { at: 'main31', reason: 'breakpoint' } } },
        calls: [
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 32, logMessage: 'counter={counter:%08lx}' } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 30, logMessage: 'toggle {ledState}', condition: 'counter > 3' } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 30, logMessage: 'never', condition: 'nosuch > 3' } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 29 } },
            { tool: 'list_breakpoints' },
            { tool: 'evaluate_expression', args: { expression: '-exec info breakpoints' } },
            { tool: 'remove_breakpoint', args: { fileFullPath: '@main.c', line: 32 } },
            { tool: 'evaluate_expression', args: { expression: '-exec delete 3' } },
            { tool: 'list_breakpoints' },
            { tool: 'add_logpoint', args: { fileFullPath: '@led.c', line: 18, logMessage: 'mask={mask}' } },
            { tool: 'stop_debugging' },
            { tool: 'start_debugging', args: { workingDirectory: '@', configurationName: 'CMSIS Debugger: pyOCD' } },
            { tool: 'list_breakpoints' },
            { tool: 'clear_all_breakpoints' },
        ],
    },
    {
        name: 'gdb-passthrough',
        description: 'Halted in main: GDB commands through evaluate_expression in both spellings — CLI commands answer with the text GDB printed (a CLI dprintf also makes the adapter announce the new breakpoint), an MI command with its result, a command GDB does not know is an error.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'evaluate_expression', args: { expression: '-exec dprintf main.c:31,"led %d\\n",ledState' } },
            { tool: 'evaluate_expression', args: { expression: '-exec info breakpoints' } },
            { tool: 'evaluate_expression', args: { expression: '>delete 2' } },
            { tool: 'evaluate_expression', args: { expression: '-exec print/x counter' } },
            { tool: 'evaluate_expression', args: { expression: '>x/1xw 0x20000010' } },
            { tool: 'evaluate_expression', args: { expression: '>-data-read-memory-bytes 0x20000000 4' } },
            { tool: 'evaluate_expression', args: { expression: '-exec frobnicate' } },
            { tool: 'evaluate_expression', args: { expression: '-exec maintenance flush dcache' } },
        ],
    },
    {
        name: 'reset-reaches-gdb',
        description: 'pyOCD, halted in main: `monitor reset halt system` resets the core; only after GDB\'s register cache is flushed does the PC read the reset vector, so the reset verifies, and the call stack shows Reset_Handler.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'reset', args: { method: 'system' } },
            { tool: 'get_call_stack' },
        ],
    },
    {
        name: 'start-debugging',
        description: 'No session: start_debugging by configuration name launches one that halts at main; a second start is refused.',
        launches: { 'CMSIS Debugger: pyOCD': { config: 'pyocd', initial: { at: 'main31', reason: 'breakpoint' } } },
        calls: [
            { tool: 'start_debugging', args: { workingDirectory: '@', configurationName: 'CMSIS Debugger: pyOCD' } },
            { tool: 'start_debugging', args: { workingDirectory: '@', configurationName: 'CMSIS Debugger: pyOCD' } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'start-debugging-fails',
        description: 'No probe: the launch fails in the adapter and startDebugging resolves false; the reply carries the problems the adapter recorded during the call, and a later start that never reached an adapter carries none.',
        launches: {
            'CMSIS Debugger: pyOCD': {
                config: 'pyocd',
                fail: {
                    // cdt-gdb-adapter forwards the GDB server's stdout and stderr as category `server`.
                    output: [['server', '0000410 C No connected debug probes [__main__]\n']],
                    message: 'Failed to launch the GDB server: pyocd exited with code 1',
                },
            },
        },
        calls: [
            { tool: 'start_debugging', args: { workingDirectory: '@', configurationName: 'CMSIS Debugger: pyOCD' } },
            { tool: 'start_debugging', args: { workingDirectory: '/elsewhere', configurationName: 'Nope' } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'unresponsive-adapter',
        description: 'Session halted, then every DAP request hangs: status and connection probes time out, a fenced read_memory returns the handler cap (its background probes are recorded as late traffic), pause is tried once and refused when it gets no answer, stop works.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, hangAfterStart: true },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'check_target_connection' },
            { tool: 'read_memory', args: { address: '0x20000000', length: 16, timeoutMs: 1000 }, settleMs: 6500 },
            { tool: 'pause_execution' },
            { tool: 'stop_debugging' },
        ],
    },
    {
        name: 'fvp-fault-without-system-registers',
        description: 'A HardFault on an Arm FVP: the GDB server zeroes SCS reads longer than a word and reports no msp, psp, control or masks '
            + '(GDB says void). The fault registers are read word by word, read_core_registers says which registers are not reported and '
            + 'takes MSP from the SP in Handler mode, and diagnose_fault reads the stacked frame there.',
        session: { initial: { at: 'hardFault', reason: 'breakpoint' }, memory: FAULT_WORDS, config: 'fvp', zeroScsBlocks: true, noSystemRegisters: true },
        calls: [
            { tool: 'read_core_registers' },
            { tool: 'diagnose_fault' },
        ],
    },
    {
        name: 'server-output-in-pieces',
        description: 'The GDB server writes its lines a few characters per output event, as the Corstone FVP\'s model output does: '
            + 'get_recent_problems lists each line once, whole, not one record per piece.',
        session: {
            initial: { at: 'main31', reason: 'breakpoint' },
            serverPieces: ['= Bl', 'in', 'ky i', 's running =\r', '\nFailed to po', 'wer up DAP\n', 'telnetterminal0: Listening for serial connection on port 5000\n'],
        },
        calls: [
            { tool: 'get_recent_problems', args: { sources: ['gdb-server'], minSeverity: 'info', limit: 3 } },
        ],
    },
    {
        name: 'unresponsive-pause-recovers',
        description: 'A running target whose adapter answers no threads probe (GDB busy with it): the status says unresponsive, yet pause_execution '
            + 'is not refused: its one pause stops the target, and the status is stopped again.',
        session: { initial: 'running', threadsHangWhileRunning: true },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'pause_execution' },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'unresponsive-gate',
        description: 'Session halted, then every DAP request hangs; a fault read with a long enough limit meets the state gate, which answers '
            + 'PROBE_WEDGED with the hint of a launch session (#3).',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, hangAfterStart: true },
        calls: [
            { tool: 'get_fault_info', args: { timeoutMs: 15000 } },
        ],
    },
    {
        name: 'focus-elsewhere',
        description: 'The session is tracked but not VS Code\'s active session (focus on another session): tools resolve it through the tracker, the SVD of read_peripheral_register too; only the active stack frame is missing.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, focusElsewhere: true },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'get_device_info' },
            { tool: 'read_peripheral_register', args: { peripheral: 'RCC', register: 'CR' } },
            { tool: 'evaluate_expression', args: { expression: 'counter' } },
            { tool: 'read_memory', args: { address: '0x20000000', length: 4 } },
        ],
    },
    {
        name: 'cmsis-build',
        description: 'No session: cmsis_action build waits for the cbuild task and reports its exit code, after checking a build that exited 0 '
            + '(CMSIS Solution reports 0 for failed builds too): 0 with the image written, 2, then 0 with the image missing and no way to re-run cbuild.',
        commands: {
            'cmsis-csolution.build': (sc) => {
                const build = (sc.builds = (sc.builds ?? 0) + 1);
                const exitCode = build === 2 ? 2 : 0;
                const image = path.join(sc.env.project, 'out', 'Blinky', 'NUCLEO-F401RE', 'Debug', 'Blinky.elf');
                if (build === 1) {
                    fs.writeFileSync(image, 'ELF');
                } else if (build === 3) {
                    // The image of build 1 goes again, so that later scenarios see the workspace as before.
                    fs.rmSync(image, { force: true });
                }
                const task = { name: 'cbuild Blinky.csolution.yml', source: 'CMSIS Solution', definition: { type: 'cmsis-csolution.build' } };
                setTimeout(() => {
                    sc.record(`task: start ${JSON.stringify(task.name)}`);
                    bus.taskStart.fire({ execution: { task } });
                    setTimeout(() => {
                        sc.record(`task: end ${JSON.stringify(task.name)} exitCode=${exitCode}`);
                        bus.taskEnd.fire({ execution: { task }, exitCode });
                    }, 20);
                }, 20);
            },
        },
        calls: [
            { tool: 'cmsis_action', args: { action: 'build' } },
            { tool: 'cmsis_action', args: { action: 'build' } },
            { tool: 'cmsis_action', args: { action: 'build' } },
        ],
    },
    {
        name: 'cmsis-rebuild-clean',
        description: 'No session: cmsis_action rebuild and clean run their CMSIS Solution commands as jobs of their own (the build task type with '
            + 'rebuild or clean set); the rebuild writes the image, the clean names the image it removed; stop_build with no build running issues nothing.',
        commands: {
            'cmsis-csolution.rebuild': (sc) => {
                fs.writeFileSync(path.join(sc.env.project, 'out', 'Blinky', 'NUCLEO-F401RE', 'Debug', 'Blinky.elf'), 'ELF');
                const task = {
                    name: 'cbuild Blinky.csolution.yml --target all --rebuild --active NUCLEO-F401RE', source: 'cmsis-csolution.build',
                    definition: { type: 'cmsis-csolution.build', rebuild: true },
                };
                setTimeout(() => {
                    sc.record(`task: start ${JSON.stringify(task.name)}`);
                    bus.taskStart.fire({ execution: { task } });
                    setTimeout(() => {
                        sc.record(`task: end ${JSON.stringify(task.name)} exitCode=0`);
                        bus.taskEnd.fire({ execution: { task }, exitCode: 0 });
                    }, 20);
                }, 20);
            },
            'cmsis-csolution.clean': (sc) => {
                const task = {
                    name: 'cbuild Blinky.csolution.yml --clean --target all', source: 'cmsis-csolution.build',
                    definition: { type: 'cmsis-csolution.build', clean: true, solution: path.join(sc.env.project, 'Blinky.csolution.yml'), active: 'NUCLEO-F401RE' },
                };
                setTimeout(() => {
                    sc.record(`task: start ${JSON.stringify(task.name)}`);
                    bus.taskStart.fire({ execution: { task } });
                    setTimeout(() => {
                        // cbuild --clean removes the image; the workspace is as before the scenario.
                        fs.rmSync(path.join(sc.env.project, 'out', 'Blinky', 'NUCLEO-F401RE', 'Debug', 'Blinky.elf'), { force: true });
                        sc.record(`task: end ${JSON.stringify(task.name)} exitCode=0`);
                        bus.taskEnd.fire({ execution: { task }, exitCode: 0 });
                    }, 20);
                }, 20);
            },
            'cmsis-csolution.stopBuild': () => undefined,
        },
        calls: [
            { tool: 'cmsis_action', args: { action: 'rebuild' } },
            { tool: 'cmsis_action', args: { action: 'clean' } },
            { tool: 'cmsis_action', args: { action: 'stop_build' } },
        ],
    },
    {
        name: 'cmsis-attach',
        description: 'No session: cmsis_action attach starts a running pyOCD attach session that survives both probes; with it active, load_and_debug and flash are refused.',
        commands: {
            'cmsis-csolution.cmsisAttachDebugger': (sc) => { sc.launch({ config: 'pyocd-attach', initial: 'running' }); },
        },
        calls: [
            { tool: 'cmsis_action', args: { action: 'attach' } },
            { tool: 'get_device_info' },
            { tool: 'cmsis_action', args: { action: 'load_and_debug' } },
            { tool: 'flash', args: {} },
            { tool: 'stop_debugging' },
        ],
    },
    {
        name: 'status-connecting',
        description: 'A pyOCD launch whose adapter takes no requests for 3 s while GDB connects (cdt-gdb-adapter answers each one with an empty success): '
            + 'the status tools report initializing, reads, the pause and a breakpoint are refused with NO_SESSION before any request reaches the target, '
            + 'and wait_for_stop sees the session stop at main once it is up. Then the GDB server exits: while the adapter shuts down the status is '
            + 'initializing again, and after that there is no session.',
        session: { connectMs: 3000, initial: { at: 'main29', reason: 'breakpoint' } },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'check_target_connection' },
            { tool: 'read_memory', args: { address: '0x20000000', length: 4 } },
            { tool: 'pause_execution', args: { timeoutMs: 1000 } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 31 } },
            { tool: 'wait_for_stop', args: { timeoutMs: 5000 } },
            { tool: 'get_session_status' },
            { tool: 'get_session_status', before: (sc) => sc.target.serverExits(1000), settleMs: 1500 },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'cmsis-attach-connect-fails',
        description: 'No session: cmsis_action attach starts a pyOCD attach session whose adapter takes no requests while GDB connects, and the connect '
            + 'fails after 600 ms: the call answers TASK_FAILED as soon as the session is gone, without probing it.',
        commands: {
            'cmsis-csolution.cmsisAttachDebugger': (sc) => {
                sc.launch({ config: 'pyocd-attach', connectMs: 600, connectFails: 'could not connect: Operation timed out.' });
            },
        },
        calls: [
            { tool: 'cmsis_action', args: { action: 'attach' } },
            { tool: 'get_session_status' },
        ],
    },
];

// ── Workspace on disk ──────────────────────────────────────────────────────

const MAIN_C = `/* Blinky for NUCLEO-F401RE: toggles LD2 every period_ms */
#include <stdbool.h>
#include <stdint.h>
#include "led.h"

#define WIFI_PASSWORD "hunter2"

volatile uint32_t counter = 0;
extern uint32_t SystemCoreClock;

typedef struct {
    uint32_t period_ms;
    uint8_t  pin;
} led_config_t;

static void delay_ms(uint32_t ms) {
    for (volatile uint32_t i = 0; i < ms * 1000u; i++) {
        __asm volatile ("nop");
    }
}
int main(void) {
    led_config_t config = { .period_ms = 500u, .pin = 5u };
    bool ledState = false;
    char buffer[16] = "Hello, Cortex-M!";
    const char *password = WIFI_PASSWORD;
    char api_key[16] = "AK-7f3a9c21e0b4";
    led_init(config.pin);
    while (1) {
        counter++;
        ledState = !ledState;
        led_toggle();
        delay_ms(config.period_ms);
    }
}
`;

const LED_C = `/* LED driver for LD2 (PA5) */
#include <stdint.h>
#include "led.h"

typedef struct {
    volatile uint32_t MODER, OTYPER, OSPEEDR, PUPDR, IDR, ODR;
} gpio_t;

static gpio_t *led_port = (gpio_t *)0x40020000u;
static uint8_t led_pin;

void led_init(uint8_t pin) {
    led_pin = pin;
}

void led_toggle(void) {
    uint32_t mask = 1u << led_pin;
    led_port->ODR ^= mask;
}
`;

const FIELD = (name, description, offset, width, access) =>
    `<field><name>${name}</name><description>${description}</description><bitOffset>${offset}</bitOffset>` +
    `<bitWidth>${width}</bitWidth>${access ? `<access>${access}</access>` : ''}</field>`;
const REGISTER = (name, description, offset, reset, access, fields) =>
    `<register><name>${name}</name><description>${description}</description><addressOffset>${offset}</addressOffset>` +
    `<size>0x20</size><access>${access}</access><resetValue>${reset}</resetValue>` +
    `${fields.length ? `<fields>${fields.join('')}</fields>` : ''}</register>`;
const BLOCK = '<addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>';

// A subset of an STM32F401, written for this oracle.
const SVD = `<?xml version="1.0" encoding="utf-8"?>
<device schemaVersion="1.3" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance">
  <vendor>STMicroelectronics</vendor>
  <name>STM32F401</name>
  <version>1.0</version>
  <description>STM32F401 subset for the DAP scenario oracle</description>
  <cpu><name>CM4</name><revision>r0p1</revision><endian>little</endian><mpuPresent>true</mpuPresent><fpuPresent>true</fpuPresent><nvicPrioBits>4</nvicPrioBits><vendorSystickConfig>false</vendorSystickConfig></cpu>
  <addressUnitBits>8</addressUnitBits>
  <width>32</width>
  <size>32</size>
  <resetValue>0x0</resetValue>
  <resetMask>0xFFFFFFFF</resetMask>
  <peripherals>
    <peripheral>
      <name>GPIOA</name>
      <description>General-purpose I/Os</description>
      <groupName>GPIO</groupName>
      <baseAddress>0x40020000</baseAddress>
      ${BLOCK}
      <registers>
        ${REGISTER('MODER', 'GPIO port mode register', '0x00', '0xA8000000', 'read-write', [
            FIELD('MODER5', 'Port x configuration bits (y = 5)', 10, 2), FIELD('MODER2', 'Port x configuration bits (y = 2)', 4, 2)])}
        ${REGISTER('IDR', 'GPIO port input data register', '0x10', '0x00000000', 'read-only', [
            FIELD('IDR13', 'Port input data (y = 13)', 13, 1)])}
        ${REGISTER('ODR', 'GPIO port output data register', '0x14', '0x00000000', 'read-write', [
            FIELD('ODR5', 'Port output data (y = 5)', 5, 1)])}
      </registers>
    </peripheral>
    <peripheral derivedFrom="GPIOA">
      <name>GPIOB</name>
      <baseAddress>0x40020400</baseAddress>
    </peripheral>
    <peripheral>
      <name>RCC</name>
      <description>Reset and clock control</description>
      <groupName>RCC</groupName>
      <baseAddress>0x40023800</baseAddress>
      ${BLOCK}
      <registers>
        ${REGISTER('CR', 'clock control register', '0x00', '0x00000083', 'read-write', [
            FIELD('HSION', 'Internal high-speed clock enable', 0, 1),
            FIELD('HSIRDY', 'Internal high-speed clock ready flag', 1, 1, 'read-only'),
            FIELD('HSEON', 'HSE clock enable', 16, 1),
            FIELD('PLLON', 'Main PLL (PLL) enable', 24, 1),
            FIELD('PLLRDY', 'Main PLL (PLL) clock ready flag', 25, 1, 'read-only')])}
        ${REGISTER('AHB1ENR', 'AHB1 peripheral clock enable register', '0x30', '0x00000000', 'read-write', [
            FIELD('GPIOAEN', 'IO port A clock enable', 0, 1), FIELD('GPIOBEN', 'IO port B clock enable', 1, 1),
            FIELD('DMA1EN', 'DMA1 clock enable', 21, 1)])}
      </registers>
    </peripheral>
    <peripheral>
      <name>USART2</name>
      <description>Universal synchronous asynchronous receiver transmitter</description>
      <groupName>USART</groupName>
      <baseAddress>0x40004400</baseAddress>
      ${BLOCK}
      <interrupt><name>USART2</name><description>USART2 global interrupt</description><value>38</value></interrupt>
      <registers>
        ${REGISTER('SR', 'Status register', '0x00', '0x00C00000', 'read-write', [
            FIELD('RXNE', 'Read data register not empty', 5, 1), FIELD('TC', 'Transmission complete', 6, 1),
            FIELD('TXE', 'Transmit data register empty', 7, 1, 'read-only')])}
        ${REGISTER('DR', 'Data register', '0x04', '0x00000000', 'read-write', [FIELD('DR', 'Data value', 0, 9)])}
        ${REGISTER('BRR', 'Baud rate register', '0x08', '0x00000000', 'read-write', [
            FIELD('DIV_Mantissa', 'mantissa of USARTDIV', 4, 12), FIELD('DIV_Fraction', 'fraction of USARTDIV', 0, 4)])}
        ${REGISTER('CR1', 'Control register 1', '0x0C', '0x00000000', 'read-write', [
            FIELD('RE', 'Receiver enable', 2, 1), FIELD('TE', 'Transmitter enable', 3, 1), FIELD('UE', 'USART enable', 13, 1)])}
      </registers>
    </peripheral>
  </peripherals>
</device>
`;

function writeWorkspace(tmp) {
    const project = path.join(tmp, 'project');
    const packRoot = path.join(tmp, 'packs');
    const svdRel = 'Keil/STM32F4xx_DFP/2.17.1/CMSIS/SVD/STM32F401x.svd';
    fs.mkdirSync(path.join(project, 'out', 'Blinky', 'NUCLEO-F401RE', 'Debug'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(packRoot, svdRel)), { recursive: true });
    fs.writeFileSync(path.join(project, 'main.c'), MAIN_C);
    fs.writeFileSync(path.join(project, 'led.c'), LED_C);
    fs.writeFileSync(path.join(project, 'Blinky.csolution.yml'),
        'solution:\n  target-types:\n    - type: NUCLEO-F401RE\n      board: STMicroelectronics::NUCLEO-F401RE\n' +
        '  build-types:\n    - type: Debug\n  projects:\n    - project: Blinky.cproject.yml\n');
    fs.writeFileSync(path.join(packRoot, svdRel), SVD);
    const cbuildRun = path.join(project, 'out', 'Blinky+NUCLEO-F401RE.cbuild-run.yml');
    fs.writeFileSync(cbuildRun, [
        'cbuild-run:',
        '  generated-by: csolution version 2.9.0',
        '  solution: ../Blinky.csolution.yml',
        '  target-type: NUCLEO-F401RE',
        '  compiler: GCC',
        '  device: STMicroelectronics::STM32F401RETx',
        '  device-pack: Keil::STM32F4xx_DFP@2.17.1',
        '  output:',
        '    - file: Blinky/NUCLEO-F401RE/Debug/Blinky.elf',
        '      info: generate by Blinky.Debug+NUCLEO-F401RE',
        '      type: elf',
        '  system-descriptions:',
        `    - file: \${CMSIS_PACK_ROOT}/${svdRel}`,
        '      type: svd',
        '  debugger:',
        '    name: CMSIS-DAP@pyOCD',
        '    protocol: swd',
        '    clock: 10000000',
        '',
    ].join('\n'));
    return { tmp, project, packRoot, cbuildRun };
}

// ── MCP client ─────────────────────────────────────────────────────────────

function request(port, method, sid, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method, agent: false,
            headers: {
                'Host': `127.0.0.1:${port}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(sid ? { 'mcp-session-id': sid } : {}),
            },
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

function parseSse(text) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text);
}

async function connect(port) {
    const init = await request(port, 'POST', undefined, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dap-scenarios', version: '1.0.0' } },
    });
    const sid = init.headers['mcp-session-id'];
    await request(port, 'POST', sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
    let id = 2;
    return {
        call: (name, args) => request(port, 'POST', sid, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })
            .then((r) => parseSse(r.body)),
        close: () => request(port, 'DELETE', sid),
    };
}

// ── Recording ──────────────────────────────────────────────────────────────

/** Replace host-, time- and run-dependent fragments so two runs compare equal. */
function normalise(text, ctx) {
    let t = String(text);
    for (const [from, to] of ctx.paths) { t = t.split(from).join(to); }
    return t
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
        .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, '<n>$2')
        .replace(/\b127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
        // The release number (with a pre-release suffix when CI set one), so that a version bump leaves the snapshot alone.
        .replace(/\bserverVersion=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g, 'serverVersion=<version>')
        // Problem-journal numbers count on across scenarios, so they depend on every scenario before, as do the records a page leaves out.
        .replace(/(^|\n)( {2})?#\d+ (error|warning|info) /g, '$1$2#<seq> $3 ')
        .replace(/… \d+ older records? left out/g, '… <n> older record(s) left out')
        .replace(/\b(sinceSeq: |nextSeq=| since #)\d+/g, '$1<seq>');
}

function normalisePaths(text, ctx) {
    let t = String(text);
    for (const [from, to] of ctx.paths) { t = t.split(from).join(to); }
    return t;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** After every reply: longer than any follow-up event the fake adapter schedules (1-5 ms). */
const QUIET_AFTER_REPLY_MS = 20;

async function withTimeout(promise, ms) {
    let timer;
    const t = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
    try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

async function runScenario(def, index, env, ctx, DebugMCPServer) {
    const sc = new ScenarioContext(def, index, env);
    current = sc;
    stub.debug.breakpoints = [];
    require(path.join(OUT, 'utils', 'sessionStateTracker.js')).forgetAdoptedBreakpoints();
    stub.debug.activeDebugSession = undefined;
    stub.debug.activeStackItem = undefined;

    const server = new DebugMCPServer(0, 30);
    await server.initialize();
    await server.start();
    const client = await connect(server.getActualPort());

    if (def.session) { sc.launch(def.session); }
    const setup = sc.log.splice(0).map((l) => normalisePaths(l, ctx));

    // A call's traffic is everything logged since the previous call's slice
    // ended; with settleMs, what arrives during the settle is its late traffic.
    const calls = [];
    let consumed = 0;
    for (const call of def.calls) {
        const args = sc.resolveArgs(call.args ?? {});
        call.before?.(sc);
        const res = await withTimeout(client.call(call.tool, args), CALL_TIMEOUT_MS);
        // The fake adapter answers some requests first and emits their events a
        // few milliseconds later (a continue's `continued` after 1 ms). Whether
        // they arrived before the reply crossed HTTP is a race, so every call
        // gets a short quiet period: follow-up events always belong to the call
        // that caused them. Deliberately delayed traffic uses settleMs.
        await sleep(QUIET_AFTER_REPLY_MS);
        const replied = sc.log.length;
        const traffic = sc.log.slice(consumed, replied);
        let late = [];
        if (call.settleMs) {
            await sleep(call.settleMs);
            late = sc.log.slice(replied);
        }
        consumed = sc.log.length;
        const entry = { tool: call.tool, args: JSON.parse(normalisePaths(JSON.stringify(args), ctx)) };
        if (res.timedOut) {
            entry.timedOut = true;
        } else {
            const r = res.result ?? {};
            const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `<${c.type}>`)).join('\n');
            if (res.error) { entry.rpcError = normalise(res.error.message, ctx); }
            if (r.isError) { entry.isError = true; }
            const missing = linesMissingFromStructured(r);
            if (missing.length > 0) { uncarried.push(`${def.name} ${call.tool}: ${JSON.stringify(missing)}`); }
            // The get_session_status trailer counts this session's calls and
            // bytes; it is metrics, not debugging behaviour, and would repeat
            // every earlier reply's size change.
            entry.text = normalise(text.replace(/\n*Tool stats \(([^)]*)\):[\s\S]*$/, '\n\nTool stats ($1): <trailer>'), ctx);
        }
        entry.traffic = traffic.map((l) => normalisePaths(l, ctx));
        if (late.length) { entry.lateTraffic = late.map((l) => normalisePaths(l, ctx)); }
        calls.push(entry);
    }

    await client.close();
    await server.stop();
    sc.teardown();
    current = null;
    return { name: def.name, description: def.description, ...(setup.length ? { setup } : {}), calls };
}

async function main() {
    const update = process.argv.includes('--update');
    const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
    const started = Date.now();

    const { DebugMCPServer } = require(path.join(OUT, 'debugMCPServer.js'));
    ({ linesMissingFromStructured } = require(path.join(OUT, 'core', 'measuredMcpServer.js')));
    const { registerSessionStateTracker } = require(path.join(OUT, 'utils', 'sessionStateTracker.js'));
    // What activate() does first: the DAP stopped/continued tracker.
    registerSessionStateTracker({ subscriptions: [] });

    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-dap-')));
    const env = writeWorkspace(tmp);
    const ctx = { paths: [[tmp, '<tmp>'], [path.resolve(__dirname, '..', '..'), '<repo>']] };
    stub.workspace.workspaceFolders = [{ uri: stub.Uri.file(env.project), name: 'Blinky', index: 0 }];
    stub.workspace.name = 'Blinky';

    const selected = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
    if (only && selected.length === 0) {
        console.error(`no scenario named ${only}; known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
        process.exit(2);
    }
    const scenarios = [];
    for (const def of selected) {
        scenarios.push(await runScenario(def, SCENARIOS.indexOf(def), env, ctx, DebugMCPServer));
    }
    fs.rmSync(tmp, { recursive: true, force: true });

    if (uncarried.length > 0) {
        console.log(`STRUCTURED CONTENT WITHOUT THE TEXT in ${uncarried.length} replies:\n  ${uncarried.join('\n  ')}`);
        process.exit(1);
    }
    const requests = scenarios.reduce((n, s) => n + s.calls.reduce((m, c) =>
        m + [...c.traffic, ...(c.lateTraffic ?? [])].filter((l) => l.startsWith('dap: ')).length, 0), 0);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const actual = JSON.stringify({ format: 1, scenarios }, null, 2) + '\n';
    if (only) {
        process.stdout.write(actual);
        console.error(`${scenarios.length} scenario, ${requests} DAP requests, ${seconds} s`);
        process.exit(0);
    }
    if (update || !fs.existsSync(SNAPSHOT)) {
        fs.writeFileSync(SNAPSHOT, actual);
        console.log(`snapshot written: ${path.relative(process.cwd(), SNAPSHOT)} ` +
            `(${scenarios.length} scenarios, ${requests} DAP requests, ${Buffer.byteLength(actual)} bytes, ${seconds} s)`);
        process.exit(0);
    }
    const expected = fs.readFileSync(SNAPSHOT, 'utf8');
    if (expected === actual) {
        console.log(`DAP scenarios identical to the snapshot (${scenarios.length} scenarios, ${requests} DAP requests, ${seconds} s)`);
        process.exit(0);
    }
    const a = expected.split('\n');
    const b = actual.split('\n');
    const first = a.findIndex((line, i) => line !== b[i]);
    console.log(`DAP SCENARIOS CHANGED — first difference at snapshot line ${first + 1}:`);
    console.log(`  expected: ${a[first]}`);
    console.log(`  actual:   ${b[first]}`);
    const out = path.join(os.tmpdir(), 'dap-scenarios.actual.json');
    fs.writeFileSync(out, actual);
    console.log(`full actual result written to ${out}; diff it against ${path.relative(process.cwd(), SNAPSHOT)}`);
    process.exit(1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
