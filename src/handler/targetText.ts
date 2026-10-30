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
 * Text for the raw target reads: core registers, memory dumps and the DWT
 * cycle counter. These show the target as it is — secret redaction never
 * applies here, since several SVDs name real registers KEY, KR or UNLOCK.
 *
 * GDB hands registers back in whatever format its target description
 * implies: decimal for `int` registers, `0x…` with a symbol for code
 * pointers, `[ Z C ]` for decoded flags, `void` for a register its target
 * description lacks. `normaliseRegister` brings the numeric ones to one hex
 * form. Pure: no `vscode` import.
 */

import type { MemoryRead } from '../executor/contract';

/** Rows of the general-purpose register table, four cells each. */
const GENERAL_ROWS: readonly (readonly string[])[] = [
    ['r0', 'r1', 'r2', 'r3'],
    ['r4', 'r5', 'r6', 'r7'],
    ['r8', 'r9', 'r10', 'r11'],
    ['r12', 'sp', 'lr', 'pc'],
];

const WORD_SPAN = 2 ** 32;

/** Bytes per hex row and characters per ASCII line of a memory dump. */
const HEX_ROW_BYTES = 16;
const ASCII_LINE_CHARS = 64;

/**
 * One register value in a comparable form. Decoded flags and placeholders
 * stay as they are; `0x…` and `0X…` lose a trailing annotation such as
 * `<main+12>`; a decimal becomes `0x` and eight hex digits. GDB prints a
 * register typed `int` (lr, xpsr, r0–r12 on pyOCD's and J-Link's target
 * descriptions) as a signed decimal, so EXC_RETURN 0xfffffff9 arrives as
 * `-7`: a negative 32-bit value is read as its two's complement.
 */
export function normaliseRegister(raw: string): string {
    const text = raw.trim();
    if (text === '' || text === '<?>' || text.startsWith('[')) {
        return text;
    }
    if (text.startsWith('0x') || text.startsWith('0X')) {
        const leadingHex = /^0[xX][0-9a-fA-F]+/.exec(text);
        return leadingHex ? `0x${leadingHex[0].slice(2)}` : text;
    }
    const decimal = parseInt(text, 10);
    if (Number.isNaN(decimal) || decimal < -(WORD_SPAN / 2)) {
        return text;
    }
    const unsigned = decimal < 0 ? decimal + WORD_SPAN : decimal % WORD_SPAN;
    return `0x${unsigned.toString(16).padStart(8, '0')}`;
}

/**
 * A register as an unsigned 32-bit number, or undefined when it has no
 * usable value: missing, a `<…>` placeholder, or anything that does not
 * normalise to plain hex (decoded flags, a negative decimal).
 */
export function registerNumber(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.startsWith('<')) {
        return undefined;
    }
    const shown = normaliseRegister(raw);
    return /^0x[0-9a-fA-F]+$/.test(shown) ? Number(shown) >>> 0 : undefined;
}

/** What GDB gives for `$name` when its target description has no such register: an unset convenience variable. */
const GDB_VOID = 'void';
/** Shown instead of `void` for a register the GDB server does not report (the Arm FVP's lacks msp, psp, control and the masks). */
const NOT_REPORTED = '<not reported by the GDB server>';

/** True when GDB's text for a register means the GDB server does not report it. */
export function isUnreportedRegister(raw: string | undefined): boolean {
    return raw !== undefined && raw.trim() === GDB_VOID;
}

/**
 * MSP when the GDB server does not report it but the core is in Handler
 * mode (IPSR, the low nine bits of xPSR, not 0): Handler mode always runs on
 * the MSP, so it is the SP. Undefined otherwise.
 */
export function mspFromHandlerSp(registers: Record<string, string | undefined>): number | undefined {
    if (!isUnreportedRegister(registers.msp)) {
        return undefined;
    }
    const xpsr = registerNumber(registers.xpsr);
    return xpsr !== undefined && (xpsr & 0x1FF) !== 0 ? registerNumber(registers.sp) : undefined;
}

/**
 * The `read_core_registers` table. `xpsr` and `control` are printed as GDB
 * gave them. A register the GDB server does not report reads as such, not
 * as GDB's `void`; MSP then comes from the SP in Handler mode.
 */
export function renderCoreRegisters(registers: Record<string, string>): string {
    const raw = (name: string): string => registers[name] ? registers[name] : '<?>';
    const value = (name: string): string => isUnreportedRegister(raw(name)) ? NOT_REPORTED : normaliseRegister(raw(name));
    const verbatim = (name: string): string => isUnreportedRegister(raw(name)) ? NOT_REPORTED : raw(name);
    const cell = (name: string): string => `${name.padEnd(4)}= ${value(name).padEnd(14)}`;
    const handlerMsp = mspFromHandlerSp(registers);
    const msp = handlerMsp === undefined
        ? value('msp')
        : `0x${handlerMsp.toString(16).padStart(8, '0')} (the SP: Handler mode runs on the MSP; the GDB server does not report msp)`;
    const lines = ['Core Registers:'];
    for (const row of GENERAL_ROWS) {
        lines.push(`  ${row.map(cell).join('')}`);
    }
    lines.push(
        `  xpsr = ${verbatim('xpsr')}`,
        `  msp  = ${msp}`,
        `  psp  = ${value('psp')}`,
        `  control   = ${verbatim('control')}`,
        `  faultmask = ${value('faultmask')}`,
        `  basepri   = ${value('basepri')}`,
        `  primask   = ${value('primask')}`,
    );
    return lines.map((line) => `${line}\n`).join('');
}

const hexByte = (byte: number): string => byte.toString(16).padStart(2, '0');

/** An address as the dump labels its rows: `0x` and at least eight lower-case hex digits. */
const dumpAddress = (address: bigint): string => `0x${address.toString(16).padStart(8, '0')}`;

/**
 * The `read_memory` dump. The header states the requested range: the
 * address as given, always taken as hex — so a decimal address is shown as a
 * different hex address and a malformed one fails with BigInt's own error —
 * and the requested length (KB13). The rows are labelled from the first byte
 * the read returned; when part of the range could not be read, the line
 * after the header says how much was read and which part was not.
 */
export function renderMemoryDump(addressText: string, length: number, read: MemoryRead, format: string, expression?: string): string {
    const prefixed = /^0x/i.test(addressText) ? addressText : `0x${addressText}`;
    const base = BigInt(prefixed);
    const { bytes, offset } = read;
    let text = `Memory at ${prefixed}${expression === undefined ? '' : ` = ${expression}`} (${length} bytes):\n`;
    const unread = unreadRanges(base, length, offset, bytes.length);
    if (unread.length > 0) {
        text += `Read ${bytes.length} of ${length} bytes: ${unread.join(' and ')} could not be read.\n`;
    }
    if (format === 'hex' || format === 'both') {
        text += '\nHex:\n';
        const first = base + BigInt(offset);
        for (let at = 0; at < bytes.length; at += HEX_ROW_BYTES) {
            const row = Array.from(bytes.subarray(at, at + HEX_ROW_BYTES), hexByte).join(' ');
            text += `  ${dumpAddress(first + BigInt(at))}: ${row}\n`;
        }
    }
    if (format === 'ascii' || format === 'both') {
        let printable = '';
        bytes.forEach((byte, position) => {
            printable += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
            if ((position + 1) % ASCII_LINE_CHARS === 0) {
                printable += '\n  ';
            }
        });
        text += `\nASCII:\n  ${printable}\n`;
    }
    return text;
}

/**
 * A `read_memory` address written as a number: hex digits after `0x`, or hex
 * digits that start with a decimal one. Anything else is an expression, so
 * `face` is the symbol of that name, never 0xface.
 */
export function isAddressLiteral(text: string): boolean {
    return /^(0x[0-9a-f]+|[0-9][0-9a-f]*)$/i.test(text);
}

/** A word that hex digits alone spell, such as `face`: GDB reads it as a name, an agent may have meant the address. */
export function isHexWord(text: string): boolean {
    return /^[a-f][0-9a-f]*$/i.test(text);
}

/** Operators that take a parenthesised operand without calling anything. */
const OPERATOR_WORDS = new Set(['sizeof', 'alignof', '_Alignof', '__alignof__']);

/** The parenthesised part of a cast such as `uint8_t *` or `unsigned long`: words, then stars. */
const CAST_TYPE = /^\s*[A-Za-z_]\w*(\s+[A-Za-z_]\w*)*\s*(\*\s*)*$/;

/**
 * What in a `read_memory` address expression would change the target when
 * GDB evaluates it: an assignment (`=`, `+=`, …), `++` or `--`, a function
 * call, or a string literal, which GDB copies into target memory. Undefined
 * for an expression that only reads. `(fp)(x)` passes as a cast: whether
 * `fp` is a type or a function pointer, only GDB knows.
 */
export function sideEffectOf(expression: string): string | undefined {
    if (expression.includes('"')) {
        return 'a string literal';
    }
    if (/\+\+|--/.test(expression)) {
        return 'an increment or decrement';
    }
    const assignment = /<<=|>>=|[-+*/%&|^]=|(?<![=!<>])=(?!=)/.exec(expression);
    if (assignment !== null) {
        return `an assignment (${assignment[0]})`;
    }
    const opens: number[] = [];
    const openOf = new Map<number, number>();
    for (let i = 0; i < expression.length; i++) {
        if (expression[i] === ')') {
            const open = opens.pop();
            if (open !== undefined) {
                openOf.set(i, open);
            }
            continue;
        }
        if (expression[i] !== '(') {
            continue;
        }
        opens.push(i);
        const before = expression.slice(0, i).trimEnd();
        const word = /[A-Za-z_$][\w$]*$/.exec(before);
        if (word !== null && !OPERATOR_WORDS.has(word[0])) {
            return `a call of ${word[0]}()`;
        }
        if (before.endsWith(']')) {
            return 'a function call';
        }
        if (before.endsWith(')')) {
            const close = before.length - 1;
            const open = openOf.get(close);
            if (open === undefined || !CAST_TYPE.test(expression.slice(open + 1, close))) {
                return 'a function call';
            }
        }
    }
    return undefined;
}

/**
 * The address in GDB's value of `(unsigned long)(expression)`, as `0x` and
 * lower-case hex: the value is decimal, or hex after `0x`, and may have more
 * after it. Undefined for a value that does not start with a number.
 */
export function addressFromValue(value: unknown): string | undefined {
    const number = /^\s*(0x[0-9a-f]+|\d+)(?![0-9a-z_])/i.exec(typeof value === 'string' ? value : '');
    return number === null ? undefined : `0x${BigInt(number[1]).toString(16)}`;
}

/** The parts of the `length` bytes from `base` that a read of `count` bytes at `offset` did not return, first and last address. */
function unreadRanges(base: bigint, length: number, offset: number, count: number): string[] {
    const span = (from: number, to: number): string => `${dumpAddress(base + BigInt(from))}–${dumpAddress(base + BigInt(to - 1))}`;
    const ranges: string[] = [];
    if (offset > 0) {
        ranges.push(span(0, offset));
    }
    if (offset + count < length) {
        ranges.push(span(offset + count, length));
    }
    return ranges;
}

/** What `readCycleCounter` reports. */
export interface CycleCounterReading {
    cycles: number;
    enabledNow: boolean;
    present: boolean;
}

/** The `read_cycle_counter` text. */
export function renderCycleCounter(reading: CycleCounterReading): string {
    if (!reading.present) {
        return 'This core has no DWT cycle counter (none on Armv6-M and Armv8-M Baseline cores such as Cortex-M0, M0+ and M23; '
            + 'elsewhere DWT_CTRL.NOCYCCNT=1) — read_cycle_counter is unavailable. '
            + 'Use an RTOS tick or a timer peripheral for timing instead.';
    }
    const parts = [`DWT cycle counter: ${reading.cycles} (0x${reading.cycles.toString(16).padStart(8, '0')})\n`];
    if (reading.enabledNow) {
        parts.push('DWT was enabled during this call — deltas are valid from now.\n');
    }
    parts.push(
        'Wrap: 32-bit, wraps every 2^32 cycles (~10.7 s @ 400 MHz) — for longer spans, sample repeatedly and accumulate.\n',
        'Note: CYCCNT stops while the core is halted and during WFE sleep — it counts ACTIVE cycles only.\n',
        'To time a region: read here, continue_execution / wait_for_stop to the end point, read again, subtract (mod 2^32).',
    );
    return parts.join('');
}
