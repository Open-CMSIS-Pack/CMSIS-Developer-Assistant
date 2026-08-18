// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { formatBreakpointModifiers } from '../debugState';
import { DebuggingHandler } from '../debuggingHandler';

/**
 * Logpoint message translation: VS Code's `{expr}` syntax has to become a GDB
 * printf format string plus an argument list. GDB infers nothing about types,
 * so the specifier rules here are load-bearing — a wrong specifier prints
 * garbage rather than erroring.
 */
suite('Logpoint message translation', () => {

    const translate = (msg: string) => DebuggingHandler.translateLogMessage(msg);

    test('plain text gets a trailing newline and no arguments', () => {
        const { format, args } = translate('reached init');
        assert.strictEqual(format, 'reached init\\n');
        assert.deepStrictEqual(args, []);
    });

    test('bare interpolation defaults to %d', () => {
        const { format, args } = translate('count={count}');
        assert.strictEqual(format, 'count=%d\\n');
        assert.deepStrictEqual(args, ['count']);
    });

    test('explicit specifier overrides the default', () => {
        const { format, args } = translate('name={name:%s} duty={duty:%f}');
        assert.strictEqual(format, 'name=%s duty=%f\\n');
        assert.deepStrictEqual(args, ['name', 'duty']);
    });

    test('length modifiers and flags are accepted in the specifier', () => {
        const { format, args } = translate('t={ticks:%08lx}');
        assert.strictEqual(format, 't=%08lx\\n');
        assert.deepStrictEqual(args, ['ticks']);
    });

    test('a C++ scope-resolution expression is not mistaken for a specifier', () => {
        const { format, args } = translate('v={ns::value}');
        assert.strictEqual(format, 'v=%d\\n');
        assert.deepStrictEqual(args, ['ns::value']);
    });

    test('doubled braces are literal braces', () => {
        const { format, args } = translate('{{literal}} x={x}');
        assert.strictEqual(format, '{literal} x=%d\\n');
        assert.deepStrictEqual(args, ['x']);
    });

    test('a literal percent is escaped for printf', () => {
        const { format, args } = translate('duty 50% at {t}');
        assert.strictEqual(format, 'duty 50%% at %d\\n');
        assert.deepStrictEqual(args, ['t']);
    });

    test('quotes and backslashes are escaped for the GDB command string', () => {
        const { format } = translate('path "C:\\dev"');
        assert.strictEqual(format, 'path \\"C:\\\\dev\\"\\n');
    });

    test('expressions keep their inner structure', () => {
        const { args } = translate('{buf[i]} {p->field} {a + b}');
        assert.deepStrictEqual(args, ['buf[i]', 'p->field', 'a + b']);
    });

    test('unbalanced braces are rejected', () => {
        assert.throws(() => translate('x={unclosed'), /Unbalanced '{'/);
        assert.throws(() => translate('x=}'), /Unbalanced '}'/);
    });

    test('empty interpolation is rejected', () => {
        assert.throws(() => translate('x={}'), /Empty interpolation/);
    });
});

/**
 * Breakpoint rendering — an agent needs to tell a plain breakpoint from a
 * conditional one or a logpoint without issuing a second call.
 */
suite('Breakpoint modifier formatting', () => {

    test('a plain breakpoint renders no suffix', () => {
        assert.strictEqual(formatBreakpointModifiers({ enabled: true }), '');
    });

    test('a condition is surfaced', () => {
        assert.strictEqual(
            formatBreakpointModifiers({ enabled: true, condition: 'i == 100' }),
            ' [when: i == 100]',
        );
    });

    test('a logpoint is surfaced', () => {
        assert.strictEqual(
            formatBreakpointModifiers({ enabled: true, logMessage: 'x={x}' }),
            ' [log: x={x}]',
        );
    });

    test('modifiers combine in a stable order', () => {
        assert.strictEqual(
            formatBreakpointModifiers({
                enabled: false,
                condition: 'n > 0',
                logMessage: 'n={n}',
                hitCondition: '>5',
            }),
            ' [when: n > 0, log: n={n}, hits: >5, disabled]',
        );
    });

    test('an absent enabled flag is not reported as disabled', () => {
        assert.strictEqual(formatBreakpointModifiers({}), '');
    });
});
