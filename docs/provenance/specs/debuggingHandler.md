# Spec: src/debuggingHandler.ts

`src/debuggingHandler.ts` sits between the MCP tool registrations (`src/debugMCPServer.ts` in the window that serves MCP, `src/controlServer.ts` in a worker window) and the VS Code debug layer (`IDebuggingExecutor`, `src/debuggingExecutor.ts`). Each debug tool maps to one `handle*` method. The method checks the session state, calls the executor (plus a few CMSIS Solution extension commands, VS Code task events and pyOCD), and returns one plain-text result. This spec is the only description of the old file the implementer gets: contract, observable behaviour, exact agent-visible text, the bugs to keep, and the tests to pin. The rewrite is behaviour-neutral. Internal structure is free: the implementer may split the work into several modules behind the same exported class.

## External contract

### Exports

| Export | Kind | Used by |
| --- | --- | --- |
| `IDebuggingHandler` | interface | `src/controlServer.ts` (type of the handler it dispatches to), `src/routingDebuggingHandler.ts` (implements it), `src/debugMCPServer.ts` (`SessionHandlers.debug`, tool registration, `getDebuggingHandler()`), `src/core/opTable.ts` (`import type`, compile-time check against `DEBUG_OPS`), `src/test/routing.test.ts` (fake handler), `src/index.ts` (re-export) |
| `CmsisAction` | type alias | `src/routingDebuggingHandler.ts` (`handleCmsisCommand` signature) |
| `DebuggingHandler` | class | `src/index.ts` (re-export), which `src/debugMCPServer.ts` (single-window default), `src/windowCoordinator.ts` (the window's local handler), `test/transport/surface-snapshot.js` and `test/transport/session-lifecycle.js` (both through `out/src/index.js`) use; `src/test/debuggingHandler.test.ts` |
| `probeSchedule` | function | `src/test/debuggingHandler.test.ts` |

Nothing else is exported. The 60 s cap and the 30 s default fence timeout are module-private constants (not exported, nobody imports them). The fence helper and the execution-outcome type are private too.

### `IDebuggingHandler`

Member names, parameter types and return types as below are the contract; the declaration form (line breaks, named argument types) is free. `src/core/opTable.ts` requires `keyof IDebuggingHandler` to equal `DEBUG_OPS` (34 names), so the interface gets no other members. `src/routingDebuggingHandler.ts` implements the same signatures, so the parameter types stay exactly as written.

```ts
export interface IDebuggingHandler {
    handleStartDebugging(args: { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string; timeoutMs?: number }): Promise<string>;
    handleStopDebugging(): Promise<string>;
    handleStepOver(args?: { timeoutMs?: number }): Promise<string>;
    handleStepInto(args?: { timeoutMs?: number }): Promise<string>;
    handleStepOut(args?: { timeoutMs?: number }): Promise<string>;
    handleContinue(args?: { timeoutMs?: number }): Promise<string>;
    handlePause(args?: { timeoutMs?: number }): Promise<string>;
    handleWaitForStop(args?: { timeoutMs?: number }): Promise<string>;
    handleRestart(args?: { timeoutMs?: number }): Promise<string>;
    handleReset(args: { method?: 'auto' | 'system' | 'core' | 'hardware'; halt?: boolean; timeoutMs?: number }): Promise<string>;
    handleAddBreakpoint(args: { fileFullPath: string; line?: number; condition?: string; lineContent?: string }): Promise<string>;
    handleAddLogpoint(args: { fileFullPath: string; line: number; logMessage: string; condition?: string }): Promise<string>;
    handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string>;
    handleClearAllBreakpoints(): Promise<string>;
    handleListBreakpoints(): Promise<string>;
    handleListVariableNames(args: { scope?: 'local' | 'global' | 'all'; timeoutMs?: number }): Promise<string>;
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all'; variableNames?: string[]; timeoutMs?: number }): Promise<string>;
    handleEvaluateExpression(args: { expression: string; timeoutMs?: number }): Promise<string>;
    handleReadMemory(args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }): Promise<string>;
    handleReadCoreRegisters(args?: { timeoutMs?: number }): Promise<string>;
    handleReadCycleCounter(args?: { timeoutMs?: number }): Promise<string>;
    handleReadPeripheralRegister(args: { peripheral: string; register?: string; timeoutMs?: number }): Promise<string>;
    handleGetFaultInfo(args?: { timeoutMs?: number }): Promise<string>;
    handleDiagnoseFault(args?: { levels?: number; timeoutMs?: number }): Promise<string>;
    handleLookupPeripheral(args?: { name?: string; address?: string; filter?: string; svdFile?: string; pname?: string; timeoutMs?: number }): Promise<string>;
    handleLookupRegister(args: { peripheral: string; register: string; svdFile?: string; pname?: string; timeoutMs?: number }): Promise<string>;
    handleGetDeviceInfo(): Promise<string>;
    handleCheckTargetConnection(): Promise<string>;
    handleGetSessionStatus(): Promise<string>;
    handleGetCallStack(args: { threadId?: number; levels?: number; timeoutMs?: number }): Promise<string>;
    handleGetThreads(args?: { timeoutMs?: number }): Promise<string>;
    handleGetFrameVariables(args: { frameId: number; scope?: 'local' | 'global' | 'all'; variableNames?: string[]; timeoutMs?: number }): Promise<string>;
    handleCmsisCommand(args: { action: CmsisAction; target?: string; timeoutMs?: number }): Promise<string>;
    handleFlash(args: { cbuildRunFile?: string; timeoutMs?: number }): Promise<string>;
}
```

### `CmsisAction`

```ts
export type CmsisAction = 'build' | 'load' | 'erase' | 'load_and_run' | 'load_and_debug' | 'attach' | 'detach' | 'stop_run';
```

### `DebuggingHandler`

- Exported class that implements `IDebuggingHandler`.
- Constructor, positional: `(executor: IDebuggingExecutor, configManager: IDebugConfigurationManager, timeoutInSeconds: number)`. `timeoutInSeconds` is the `cmsis-developer-assistant.timeoutInSeconds` setting (default 180; the tests use 5 and 30).
- Public static `translateLogMessage(logMessage: string): { format: string; args: string[] }` (see [Logpoint message translation](#logpoint-message-translation)). The unit test calls it on the class.
- Two public methods have no caller anywhere (codebase review, dead code): `getCurrentDebugState(): Promise<DebugState>` (returns `executor.getCurrentDebugState(3)`) and `isDebuggingActive(): Promise<boolean>` (returns `executor.hasActiveSession()`). They are not part of the contract; omitting them is recommended.
- Structural requirements:
  - `ControlServer` looks up a method by its `DEBUG_OPS` name on the handler object and calls it with `this` bound to the handler and exactly one argument, `args ?? {}`. Methods without parameters then receive `{}` and must ignore it. Methods with optional `args` must accept both `undefined` and `{}`.
  - The class must not have both `listDebugWindows` and `selectDebugWindow` methods: `debugMCPServer.ts` treats any handler that has both as the window router.
  - Two instances can exist in one window: the single-window default in `debugMCPServer.ts` and the window coordinator's local handler. All per-handler memory (the breakpoint diff below) is per instance. There is no module-level mutable state.
  - Do not import `routingDebuggingHandler`, `debugMCPServer`, `controlServer` or `windowCoordinator`, because they import this module.

### `probeSchedule`

`export function probeSchedule(budgetMs: number): { firstDelayMs: number; secondDelayMs: number; probeMs: number }`. It is pure and says when the session-survival check probes:

- `budget` = max(`budgetMs`, 1 000).
- `probeMs` = min(5 000, floor(`budget` / 4)).
- `firstDelayMs` = floor(`budget` × 0.35).
- `secondDelayMs` = max(0, floor(`budget` × 0.75) − `firstDelayMs` − `probeMs`).

Example: `probeSchedule(8000)` is `{ firstDelayMs: 2800, secondDelayMs: 1200, probeMs: 2000 }`.

### Dependencies the behaviour relies on

- **Executor** (`IDebuggingExecutor`, `src/debuggingExecutor.ts`). Methods used: `hasDebugSession()` (synchronous: a session object exists), `hasActiveSession()` (a session exists and the target is stopped), `getSessionStatus()` (`SessionStatus`: `state` is one of `'no-session' | 'initializing' | 'running' | 'stopped' | 'unresponsive'`, plus `sessionName`, `sessionType`, `configurationName`, `dapResponsive`, `dapProbeMs`, `detail?`), `getDiagnostics()` (`serverVersion`, `liveSessionCount`, `liveSessionNames`, `hasVscodeActiveSession`), `startDebugging`, `startDebuggingByName`, `stopDebugging`, `restart`, `stepOver`, `stepInto`, `stepOut`, `continue`, `pause`, `armStopWaiter`, `waitForStop`, `getCurrentDebugState`, `addBreakpoint`, `removeBreakpoint`, `getBreakpoints`, `clearAllBreakpoints`, `setBreakpointViaGdb`, `setLogpointViaGdb`, `setBreakpointConditionViaGdb`, `clearBreakpointViaGdb`, `clearAllBreakpointsViaGdb`, `getVariables`, `getVariablesForFrame`, `evaluateExpression`, `readMemory`, `readCoreRegisters`, `readCycleCounter`, `readPeripheralRegister`, `getFaultInfo`, `readFaultRegisters`, `readExceptionFrame`, `resetTarget`, `getDeviceInfo`, `checkTargetConnection`, `getThreads`, `getCallStack`. The exact arguments are given per method below.
- **Configuration manager** (`IDebugConfigurationManager`): `promptForConfiguration(workingDirectory)` and `getDebugConfig(workingDirectory, fileFullPath, configurationName?, testName?)`.
- **`src/debugState.ts`**:
  - `new DebugState()` gives an empty state with `sessionActive` false.
  - `state.toString()` renders the full JSON form; `state.toCompactString({ includeBreakpoints })` renders the compact JSON form. Pass only `includeBreakpoints`, so the default frame cap applies.
  - Fields read: `breakpoints: string[]`, `frameName`, `fileName`, `currentLine`, `currentLineContent`.
  - `formatBreakpointModifiers(bp)` renders the modifier suffix: a space, then `[when: …, log: …, hits: …, disabled]` with only the parts that apply, or nothing.
- **`src/utils/secretRedaction.ts`**: `redactVariableValue(name, value)`, `redactExpressionResult(expression, value)` (both return `{ value: string; redacted: boolean }`) and `REDACTION_NOTICE`.
- **Arm-authored modules** (read them freely):
  - `src/utils/sessionStateTracker.ts`: `getRecentDiagnostics`, `resolveActiveSession`, `getStoppedReason`.
  - `src/utils/timeout.ts`: `withTimeout`, `HardwareTimeoutError`.
  - `src/core/cmsisTarget.ts`, `src/core/flashController.ts`, `src/core/resetAssist.ts`, `src/core/variableView.ts`, `src/core/textBudget.ts`, `src/core/svdParser.ts`, `src/core/svdLookup.ts`, `src/core/faultDecoder.ts`, `src/core/faultTriage.ts`.
  - `src/utils/logger.ts` (`logger.info`, `logger.warn`, `logger.error`).
- **VS Code API**: `vscode.Uri.file`, `vscode.Uri.joinPath`, `vscode.workspace.openTextDocument`, `vscode.workspace.workspaceFolders`, `vscode.workspace.getWorkspaceFolder`, `vscode.workspace.getConfiguration`, `vscode.workspace.findFiles`, `vscode.debug.activeStackItem`, `vscode.SourceBreakpoint` / `vscode.FunctionBreakpoint` (instance checks), `vscode.commands.executeCommand`, `vscode.tasks.onDidStartTaskProcess` / `onDidEndTaskProcess`.
- **Other**: `jsonc-parser` (`parse`) for `launch.json`; Node `fs` / `path`.

## Behaviour

### Conventions

- "Returns T": the promise resolves with text T, and the MCP layer sends it as a normal (non-error) result.
- "Throws T": the promise rejects with an `Error` whose message is T. The MCP SDK turns that into `isError: true` with the message as text. Over the control channel the router wraps it into its own "Could not reach …" text (router behaviour, not this module).
- `String(error)`: JavaScript string conversion of a caught value. For an `Error` this is `⟨name⟩: ⟨message⟩`, e.g. `Error: …` or `TypeError: …`. Wrappers embed `String(error)`, which is why agent-visible texts read "… : Error: …".
- `message(error)`: `error.message` for an `Error`, otherwise `String(error)`.
- IDs such as `G1` refer to entries in [Agent-visible text](#agent-visible-text).
- Every `executor.getCurrentDebugState` call passes 3, the number of next lines.

### Method overview

| Method | Tool | Fence label (timeout source) | Gate operation | On error |
| --- | --- | --- | --- | --- |
| `handleStartDebugging` | `start_debugging` | none | none | throws `ST10` |
| `handleStopDebugging` | `stop_debugging` | none | none | throws `SP4` |
| `handleStepOver` | `step_over` | none | `step over` | throws `M11` |
| `handleStepInto` | `step_into` | none | `step into` | throws `M12` |
| `handleStepOut` | `step_out` | none | `step out` | throws `M13` |
| `handleContinue` | `continue_execution` | none | `continue execution` | throws `M14` |
| `handlePause` | `pause_execution` | none | none | propagates unchanged |
| `handleWaitForStop` | `wait_for_stop` | `wait_for_stop` (`timeoutMs`) | none | fence text |
| `handleRestart` | `restart_debugging` | none | none | throws `RS4` |
| `handleReset` | `reset` | `reset` (`timeoutMs`) | none | fence text |
| `handleAddBreakpoint` | `add_breakpoint` | none | none | throws `BP13` |
| `handleAddLogpoint` | `add_logpoint` | none | none | throws `LP9` |
| `handleRemoveBreakpoint` | `remove_breakpoint` | none | none | throws `RM5` |
| `handleClearAllBreakpoints` | `clear_all_breakpoints` | none | none | throws `CL5` |
| `handleListBreakpoints` | `list_breakpoints` | none | none | throws `LB5` |
| `handleListVariableNames` | `list_variable_names` | `list_variable_names` (`timeoutMs`) | `list variable names` | fence text |
| `handleGetVariables` | `get_variables_values` | `get_variables_values` (`timeoutMs`) | `read variables` | fence text |
| `handleEvaluateExpression` | `evaluate_expression` | `evaluate_expression` (`timeoutMs`) | `evaluate expression` | fence text |
| `handleReadMemory` | `read_memory` | `read_memory` (`timeoutMs`) | `read memory` | fence text |
| `handleReadCoreRegisters` | `read_core_registers` | `read_core_registers` (`timeoutMs`) | `read core registers` | fence text |
| `handleReadCycleCounter` | `read_cycle_counter` | `read_cycle_counter` (`timeoutMs`) | `read cycle counter` | fence text |
| `handleReadPeripheralRegister` | `read_peripheral_register` | `read_peripheral_register` (`timeoutMs`) | `read peripheral register` | fence text |
| `handleGetFaultInfo` | `get_fault_info` | `get_fault_info` (`timeoutMs`) | `read fault info` | fence text |
| `handleDiagnoseFault` | `diagnose_fault` | `diagnose_fault` (`timeoutMs`) | `diagnose the fault` | fence text |
| `handleLookupPeripheral` | `lookup_peripheral` | `lookup_peripheral` (`timeoutMs`) | none | fence text |
| `handleLookupRegister` | `lookup_register` | `lookup_register` (`timeoutMs`) | none | fence text |
| `handleGetDeviceInfo` | `get_device_info` | none | none | throws `DI3` |
| `handleCheckTargetConnection` | `check_target_connection` | none | none | returns `TC1` or throws `TC2` |
| `handleGetSessionStatus` | `get_session_status` | none | none | propagates unchanged |
| `handleGetCallStack` | `get_call_stack` | `get_call_stack` (`timeoutMs`) | `get call stack` | fence text |
| `handleGetThreads` | `get_threads` | `get_threads` (`timeoutMs`) | `get threads` | fence text |
| `handleGetFrameVariables` | `get_frame_variables` | `get_frame_variables` (`timeoutMs`) | `get frame variables` | fence text |
| `handleCmsisCommand` | `cmsis_action` | `cmsis_action` (see method) | none | fence text |
| `handleFlash` | `flash` | `flash` (`timeoutMs`, default 60 000) | none | fence text |

"Fence text" means the method never rejects: errors come back as `F2` and overruns as `F1`, both as normal results (known bug KB1). Where a method has a gate, the gate is the first thing it does (inside its fence and error wrapper), before any argument processing or other executor call.

### Shared machinery

#### Handler fence

- Wraps a method body with a label and an optional `timeoutMs`.
- Effective limit: a positive `timeoutMs` is clamped to at most 60 000 ms; `undefined`, 0 or a negative value gives 30 000 ms.
- The body races a timer. If the body resolves first, its text is returned. If the body rejects, the fence returns `F2` with `message(error)`. If the timer fires first, the fence returns `F1` with the effective limit in ms.
- The timer is cleared once the race settles. The body is not cancelled (a DAP request cannot be aborted): it keeps running, and its late result or rejection is discarded without an unhandled rejection.
- The fence itself never throws.

#### Stopped-session gate

- Input: an operation phrase (column "Gate operation" in the overview).
- `executor.hasActiveSession()` true: proceed.
- Otherwise the gate reads `executor.getSessionStatus()` and throws `G1` with the phrase, the state and the hint for that state: `no-session` gives `G2`, `initializing` `G3`, `running` `G4`, `unresponsive` `G5`, `stopped` `G6` (the status changed between the two calls).

#### Adapter diagnostics suffix

`getRecentDiagnostics()` from `sessionStateTracker` returns a list of recent adapter lines. An empty list gives an empty suffix; otherwise the suffix is `D1`. It is appended to `ST10`, `CA6` and `CA13`.

#### Secret redaction hook

- Read on every call (not cached): `vscode.workspace.getConfiguration('cmsis-developer-assistant').get('redactSecrets', true)`.
- On: the variable renderers get a callback `(name, value) => redactVariableValue(name, value)`, and `evaluate_expression` uses `redactExpressionResult` except for GDB passthrough expressions (see that method).
- Off: no callback, and `evaluate_expression` returns `String(result)` unredacted.
- Never applied to `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info` or `diagnose_fault`: they return raw target state, and several SVDs name real registers KEY, KR or UNLOCK.

#### State rendering and breakpoint diff

- Each handler instance remembers the breakpoint list it last emitted: the state's `breakpoints` joined with a line feed. Initially nothing has been emitted, which is different from an emitted empty list.
- **Full state** is `state.toString()`. Rendering it records the list. Used by `ST2`, `ST3` and `CA12`.
- **Compact state** is `state.toCompactString({ includeBreakpoints: changed })`, where `changed` is true when the joined list differs from the remembered one (always true the first time). Rendering it records the list. Used by `M1` and by motion bodies without a stop reason, and by `P8`, `W4` and `W5`.
- The timeout-recovery text reads state fields directly and neither reads nor updates the memory.

#### Waiting for a live session

- Budget: a positive override is clamped to at most 60 000 ms; without one the budget is min(`timeoutInSeconds` × 1 000, 60 000).
- While less than the budget has elapsed: read `executor.getSessionStatus()`. On `stopped` or `running`, log (info) and report success. Otherwise log (info) the attempt number and state, then sleep min(1 000 × 2^attempt, 10 000) ms plus up to 200 ms of random jitter, attempt counting from 0.
- When the loop ends, report failure. Polls happen at about 0, 1, 3, 7, 15, 25 … s, and the last sleep can overshoot the budget (known bug KB10).
- Used by `start_debugging` and `restart_debugging` (no override) and by `cmsis_action` `load_and_debug` / `attach` (override 8 000).

#### Stop waiter

This is the only way continue, step and pause wait for the target.

- Wait limit: a positive override is clamped to at most 60 000 ms; without one the limit is min(`timeoutInSeconds` × 1 000, 60 000).
- Order:
  1. Call `executor.armStopWaiter(limit)` and keep the returned promise.
  2. Then await the execution request (the executor's `continue`, `stepOver`, `stepInto`, `stepOut` or `pause`, called with the tool's `timeoutMs`).
  3. Then await the armed promise.
- If the request throws, the error propagates, and the armed waiter is left to expire on its own.
- The outcome kinds are `stopped` (with `reason` and `threadId`), `timeout` and `ended`. On `timeout`, log a warning.
- Afterwards the state is read with `executor.getCurrentDebugState(3)`. If that read throws, an empty `new DebugState()` is used.
- Result: the state, whether it timed out, whether the session ended, and the stop reason (only for `stopped`, otherwise none).
- It must never settle on VS Code's active-stack-item change events, which also fire when the item is cleared on resume. Only the armed DAP `stopped` event (or its timeout or the session end) settles it.

#### Motion result and timeout recovery

Applies to `step_over`, `step_into`, `step_out` and `continue_execution`, with `op` set to the tool name.

- Body: `M1` when there is a stop reason, otherwise the compact state alone.
- The session ended: return body + `M2`.
- It timed out: return body + `M3` + the recovery text below. `M3` names `timeoutInSeconds`, not the effective wait (known bug KB8).
- Otherwise return the body.
- Recovery: its lines are joined with a line feed, and the first line is `M4` (which itself starts with a line feed). It never throws.
  1. Arm and pause through the stop waiter with `executor.pause(5000)` and a 5 000 ms limit.
  2. If the pause request throws: `M10`.
  3. If the session ended: `M5`. If it timed out: `M6`.
  4. If it stopped: read `executor.readCoreRegisters(5000, ['pc', 'lr'])`.
     - PC: normalised if present, otherwise `<unavailable>`. If the read throws, PC is `<read failed: ⟨message(error)⟩>` and LR is omitted.
     - LR: normalised if present.
     - Emit `M7`, with frame name, file name and line from the recovered state; then `M8` if the state has current-line content; then `M9`.

#### Register value normalisation

Applied to a register string after trimming:

1. Empty or `<?>`: unchanged.
2. Starts with `[` (decoded flags such as `[ Z C GE=0 ]`): unchanged.
3. Starts with `0x` or `0X`: keep the leading run of hex digits as `0x` + digits, which drops a trailing annotation such as `<main+12>`.
4. Anything else is parsed like `parseInt(text, 10)`: leading digits, trailing text ignored. A non-negative result becomes `0x` + (value mod 2^32) in lower-case hex, zero-padded to 8 digits; a negative result down to -2^31 is read as its 32-bit two's complement (GDB prints registers typed `int` — lr, xpsr, r0–r12 on pyOCD's and J-Link's target descriptions — as signed decimals, so EXC_RETURN 0xfffffff9 arrives as `-7`). NaN or a value below -2^31: unchanged.

The numeric register value used by `diagnose_fault` is undefined when the string is missing or starts with `<`. Otherwise it is normalised; if the result is not exactly `0x` followed by hex digits it is undefined, else it is the unsigned 32-bit number.

#### GDB reply classification

Classifies the raw reply of a GDB `break` or `dprintf` sent by the executor. `null` or `undefined` counts as empty; the reply is trimmed.

- `bound`: contains `Breakpoint`, whitespace, digits, whitespace, `at` (case-insensitive).
- `rejected` (checked only when not bound): contains, case-insensitive, any of `No source file named`, `No line` + whitespace + digits + whitespace + `in`, `No symbol`, `Function "` + text without quotes + `" not defined` (whitespace between the parts), `No such file`, `cannot be inserted`, `No default breakpoint address`.
- `unconfirmed`: everything else, including empty replies and the adapter's generic "could not evaluate expression".

Two related checks:

- **Echo check** for `clear` / `delete` replies: the reply contains, case-insensitive, `Deleted`, `Breakpoint`, `No source` or `No symbol`.
- **Breakpoint number** from a `dprintf` reply: the digits in the first case-insensitive match of `Dprintf` or `Breakpoint`, whitespace, digits, whitespace, `at`; none when absent.

#### Logpoint message translation

`DebuggingHandler.translateLogMessage(logMessage)` turns a VS Code logpoint message into a GDB `dprintf` format string plus argument expressions. It scans left to right:

- `{{` and `}}` become a literal `{` and `}`.
- `{` starts an interpolation that ends at the next `}`.
  - No `}` follows: throw `LP10` (position = index of the `{`).
  - The inner text is trimmed. Empty: throw `LP11`.
  - If the inner text ends with a colon followed directly by a printf conversion, the conversion goes into the format and the text before that colon (trimmed) becomes the argument. The conversion is `%`, then optional characters from `-+ #0123456789.`, then an optional length modifier `hh`, `h`, `ll`, `l`, `z`, `j`, `t` or `L`, then one of `d i o u x X e E f g G a A c s p`. The split is at the last colon of the inner text, so the expression part may itself contain colons, and there is no whitespace between that colon and `%`. Otherwise `%d` goes into the format and the whole inner text becomes the argument.
- A lone `}`: throw `LP12`.
- Other characters, escaped for printf and the GDB command string: `%` becomes `%%`, `"` becomes backslash + `"`, a backslash becomes two backslashes, a line feed becomes backslash + `n`, and everything else is copied.
- Finally backslash + `n` is appended to the format.

Examples: `count={count}` gives `count=%d\n` (literal backslash-n) with `['count']`; `t={ticks:%08lx}` gives `t=%08lx\n` with `['ticks']`; `v={ns::value}` gives `v=%d\n` with `['ns::value']`.

#### CMSIS Solution queries

Neither query ever throws.

- **Active solution.** `vscode.commands.executeCommand('cmsis-csolution.getSolutionFile')`, raced by `withTimeout('cmsis getSolutionFile', 5000, …)`.
  - Falsy result: not active, description `none`.
  - String: active, path = the string.
  - Object: active, path = the first defined of `solutionFile`, `fsPath`, `path`, `uri.fsPath`, `uri.path`.
  - Any other truthy value: active without a path.
  - Description for an active solution: the path, or `<active, path unknown>`.
  - Error or timeout: not active, description `query failed: ⟨message(error)⟩`.
- **Active target.** `vscode.commands.executeCommand('cmsis-csolution.getActiveTargetSet')`, raced by `withTimeout('cmsis getActiveTargetSet', 5000, …)`.
  - A string result is trimmed and anything else counts as empty. The name is the trimmed string, or none when empty.
  - Error or timeout: no name.

#### Target switch

Makes a requested target (`TargetRef` from `parseTargetRef`) active before a `cmsis_action` runs. Inputs: the solution path (may be missing), the wanted reference, and the currently active name. The result is either success with the new active name, or a reason. The reasons are `TS2`–`TS7`; all except `TS4` end with `TS1`. `was` is the active name or `(none)`. Steps, in order, stopping at the first failure:

1. The path is missing or does not exist (`fs.existsSync`): `TS2`.
2. Read the csolution file (UTF-8). A read error gives `TS3`. Otherwise `listTargetTypes(text)`.
3. `resolveTargetSelection(types, wanted)`. Not ok: `TS4`, with `formatTargetChoices(types)`, or `(none found)` when that is empty. Nothing is written in this case.
4. Folder: the workspace folder containing the solution (`vscode.workspace.getWorkspaceFolder`), else the first workspace folder, else the solution's directory. Write `⟨folder⟩/.vscode/cmsis.json`: create the directory recursively, read the existing text (empty if the file is absent), apply `applyTargetSelection(before, solutionDisplayName(folder, solutionPath), resolved.type, resolved.setIndex)`, write the result as UTF-8. Any error: `TS5`.
5. `executeCommand('cmsis-csolution.deactivateSolution')` under `withTimeout('cmsis deactivateSolution', 10000, …)`, then `executeCommand('cmsis-csolution.activateSolution', solutionPath)` under `withTimeout('cmsis activateSolution', 10000, …)`. Any error: `TS6`.
6. Verify with a 15 s deadline. Loop: query the active target. If it is set and `targetMatches(seen, wanted)`, succeed with `seen`. If the deadline has passed, stop. Otherwise sleep 500 ms and repeat. On exhaustion: `TS7`, with the last seen name or `(none)`.

#### Session survival probe

Used after `cmsis_action` `load_and_debug` / `attach` found a live session. The budget is 8 000 ms and the schedule comes from `probeSchedule(budget)`.

- Sleep `firstDelayMs`, probe with label `t+⟨round(firstDelayMs / 1000)⟩s`, sleep `secondDelayMs`, then probe with label `t+⟨round((firstDelayMs + probeMs + secondDelayMs) / 1000)⟩s`. With 8 000 the labels are `t+3s` and `t+6s`.
- Each probe gives a detail string:
  - `executor.hasDebugSession()` false: `PR1`, not ok.
  - Otherwise `executor.getThreads(probeMs)`: at least one thread gives `PR2` (ok); zero threads give `PR3` (not ok); an error gives `PR4` (not ok).
- Only the second probe decides. Ok gives stable with detail `PR5`. Not ok gives unstable with detail `PR6`.

#### CMSIS task waiter

Used by `cmsis_action` `build`, `load`, `erase` and `load_and_run` to learn how the task that the CMSIS Solution command starts ends. Access `vscode.tasks` only for these four actions: the transport stub has no `vscode.tasks`, and `detach` runs through the transport test.

- Armed before the command is issued, with budget max(5 000, effective timeout − 3 000) ms, counted from arming.
- Subscribes to `vscode.tasks.onDidStartTaskProcess` and `vscode.tasks.onDidEndTaskProcess`.
- A task counts as a CMSIS task when a haystack matches the case-sensitive pattern `cmsis` or `cbuild`. The haystack is the task name, a space, the task source (only if it is a string, else empty), a space, and the task definition's `type` (else empty). Only the definition type is lower-cased; name and source keep their case (known bug KB5). So `CMSIS Load` / source `Workspace` / type `shell` does not match, while a name starting with `cbuild` or a definition type `cmsis-csolution.build` does.
- Process start of a matching task: mark started and remember its name (the latest wins).
- Process end of a matching task: settle with done, started, the event's `exitCode` (may be undefined) and the task name. This is the first matching end from any execution (known bug KB5).
- Budget expires first: settle with not done, the started flag and the remembered name.
- On settling: stop the timer and dispose the subscriptions (swallow dispose errors); later events are ignored. The waiter never rejects.

#### cbuild-run resolution

Used by `flash`. Picks the `*.cbuild-run.yml` to program, as a path or an error text. Only the first workspace folder counts.

1. Explicit argument: absolute paths are used as given; relative ones are joined to the first workspace folder, or used as given when there is none. Not an existing file (`fileExists` from `flashController`): `FL2` with the resolved path.
2. No workspace folder: `FL3`.
3. Open `⟨folder⟩/.vscode/launch.json` through `vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json'))`, so unsaved editor content counts, and parse it with `jsonc-parser`. For each entry of `configurations` (when that is an array), in order: take `cmsis.cbuildRunFile` when it is a non-empty string that does not contain `${command:`. Resolve it against the folder unless absolute. The first one that `fileExists` wins. Any error here falls through silently.
4. `vscode.workspace.findFiles('out/**/*.cbuild-run.yml', '**/node_modules/**', 10)`: exactly one match wins; more than one gives `FL4` listing each `fsPath`; none gives `FL5`.

### Methods

#### `handleStartDebugging`

- Arguments: `fileFullPath?`, `workingDirectory`, `testName?`, `configurationName?`, `timeoutMs?`. `timeoutMs` is accepted and ignored (known bug KB9). Not fenced.
- `executor.hasDebugSession()` true: read `getSessionStatus()` and return `ST1`. The config manager is not touched.
- Everything else runs inside one wrapper: any error throws `ST10`, which is `String(error)` + the diagnostics suffix.
  1. Configuration: `configurationName` when it is not `null` / `undefined` (an empty string is kept), otherwise `await configManager.promptForConfiguration(workingDirectory)`. This must be the first call that can fail. In the transport stub it throws, which gives the snapshot text `Error starting debug session: TypeError: vscode.Uri.joinPath is not a function`.
  2. Named path, when the configuration is truthy and not `Default Configuration`: `executor.startDebuggingByName(workingDirectory, name)`. False: throw `ST7`. True: wait for a live session (no override); failure throws `ST6`. Then `getCurrentDebugState(3)` and return `ST2`, where the target is `fileFullPath` when non-empty, else the configuration name, and the state is rendered in full.
  3. File path, otherwise: a missing or empty `fileFullPath` throws `ST8`. Else `configManager.getDebugConfig(workingDirectory, fileFullPath, configuration, testName)`, then `executor.startDebugging(workingDirectory, config)`. False: throw `ST9`. True: wait for a live session (no override); failure throws `ST6`. Then `getCurrentDebugState(3)` and return `ST3`. The configuration part is `ST4` when the configuration is truthy, else `ST5`. The test part is `ST11` when `testName` is truthy.

#### `handleStopDebugging`

- No arguments. Not fenced. The target may be running or the probe unresponsive; only session existence is checked.
- `executor.hasDebugSession()` false: return `SP1`.
- Otherwise `executor.stopDebugging()` with no argument, then return `SP2` + a blank line + `SP3`.
- Any error: throw `SP4` with `String(error)`.

#### `handleStepOver`, `handleStepInto`, `handleStepOut`, `handleContinue`

- Arguments: optional `{ timeoutMs }`. Not fenced.
- Gate (`step over`, `step into`, `step out`, `continue execution`).
- Stop waiter: the request is `executor.stepOver(timeoutMs)` / `stepInto(timeoutMs)` / `stepOut(timeoutMs)` / `continue(timeoutMs)`, and the limit override is `timeoutMs`.
- Return the motion result with `op` `step_over`, `step_into`, `step_out` or `continue_execution`, including the recovery on timeout.
- Any error, the gate's included: throw `M11`, `M12`, `M13` or `M14` with `String(error)`.
- On the motion path the executor methods used are only `hasActiveSession`, `getSessionStatus`, `armStopWaiter`, the motion request, `pause`, `getCurrentDebugState` and `readCoreRegisters`. The unit-test fake implements only these, plus `hasDebugSession`.

#### `handlePause`

- Arguments: optional `{ timeoutMs }`. Not fenced, with no wrapper: errors propagate with their own message.
- `executor.hasDebugSession()` false: throw `P1`.
- `executor.getSessionStatus()`:
  - `stopped`: return `P2` with `detail`, or `n/a`.
  - `unresponsive`: return `P3`.
  - `no-session`: throw `P4`.
  - `initializing`: return `P5`.
  - `running`: stop waiter with request `executor.pause(timeoutMs)` and limit override `timeoutMs`. Timeout: return `P6`. Ended: return `P7`. Stopped: return `P8` with the compact state. There is no stop reason and no recovery.

#### `handleWaitForStop`

- Fenced `wait_for_stop` with `timeoutMs`. Issues no execution request.
- `executor.hasDebugSession()` false: throw `W1`, which the fence returns as `F2`.
- Wait budget: when `timeoutMs` is truthy, max(`timeoutMs` − 1 500, 100); otherwise 28 500. The margin lets this text win over the fence. Call `executor.waitForStop(budget)`.
  - `timeout`: return `W2`. `ended`: return `W3`.
  - `stopped` or `already-stopped`: sleep 300 ms (settle), then `getCurrentDebugState(3)`. Return `W4` for `already-stopped`, or `W5` for `stopped` (with the thread part only when `threadId` is not null), each followed by a blank line and the compact state. A missing reason reads `unknown`.

#### `handleRestart`

- Arguments: ignored (known bug KB9). Not fenced. Not gated on run state (known bug KB3).
- Inside a wrapper:
  1. `executor.hasDebugSession()` false: throw `RS1`.
  2. `executor.restart()`.
  3. Wait for a live session (no override). Failure throws `RS2`, which names `timeoutInSeconds` (known bug KB8).
  4. Return `RS3`.
- Any error: throw `RS4` with `String(error)`.

#### `handleReset`

- Fenced `reset` with `timeoutMs`. No gate: the executor halts a running target itself.
- `executor.hasDebugSession()` false: throw `RE1`.
- `executor.resetTarget({ method: args.method ?? 'auto', halt: args.halt, timeoutMs: args.timeoutMs })`, then return `renderResetOutcome(outcome, args.halt)` from `src/core/resetAssist.ts`.

#### `handleAddBreakpoint`

- Arguments: `fileFullPath`, `line?`, `condition?`, `lineContent?`. Not fenced, not gated on run state (known bug KB3). Any error throws `BP13` with `String(error)`.
- Target lines:
  - When `line` is a number it wins. It must be an integer ≥ 1, else throw `BP1`.
  - Else, with no `lineContent`, throw `BP2`.
  - Else (deprecated form): read the file with `vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath))`. This must be the document API: the transport stub throws `not stubbed` there, and the snapshot pins `Error adding breakpoint: Error: not stubbed`. Split the text on CRLF or LF and take the 1-based number of every line that contains `lineContent` (case-sensitive substring). None: throw `BP3`.
- Model: for each target line in order, `await executor.addBreakpoint(vscode.Uri.file(fileFullPath), line, { condition })`.
- GDB, only when `executor.hasDebugSession()`: for each target line in order, `reply = await executor.setBreakpointViaGdb(fileFullPath, line, undefined, condition)`. Classify each reply. Build one entry `BP9` per line; for `unconfirmed` the entry shows `<no echo from adapter — normal>` instead of the reply.
- Head: `BP4` for one line, else `BP5` (lines joined with a comma and a space). Either gets the condition suffix `BP6` when `condition` is truthy. After the deprecated form, append `BP7`.
- Result, the first that applies:
  1. No debug session (checked again): head + `BP8`.
  2. Any `rejected`: head + `BP10`.
  3. Any `bound`: head + `BP11`.
  4. Otherwise: head + `BP12`.

#### `handleAddLogpoint`

- Arguments: `fileFullPath`, `line`, `logMessage`, `condition?`. Not fenced, not gated (known bug KB3). Any error throws `LP9` with `String(error)`.
- In order:
  1. `line` must be an integer ≥ 1, else throw `BP1`.
  2. Translate the message; this may throw `LP10`–`LP12`.
  3. `await executor.addBreakpoint(vscode.Uri.file(fileFullPath), line, { condition, logMessage })`.
- No debug session: return `LP1` + `LP2`.
- Otherwise `reply = await executor.setLogpointViaGdb(fileFullPath, line, format, args)` and classify it. The output is these lines, joined with a line feed:
  1. `LP1`, then `LP3`.
  2. `rejected`: `LP4`, `LP5`, and return here.
  3. When `condition` is truthy: read the breakpoint number from the reply. If there is one, `condReply = await executor.setBreakpointConditionViaGdb(number, condition)` and add `LP6`. If there is none, add `LP7`.
  4. `LP8`, which starts with a line feed, so a blank line precedes it.
- `bound` and `unconfirmed` read the same. Both the model logpoint and the GDB `dprintf` exist afterwards (known bug KB6).

#### `handleRemoveBreakpoint`

- Arguments: `fileFullPath`, `line`. Not fenced, not gated (known bug KB3). Any error throws `RM5` with `String(error)`.
- Look in `executor.getBreakpoints()` for a `vscode.SourceBreakpoint` whose `location.uri.toString()` equals that of `vscode.Uri.file(fileFullPath)` and whose `location.range.start.line` equals `line − 1`. None: return `RM1`, with no GDB call (known bug KB12).
- `await executor.removeBreakpoint(uri, line)`.
- With a debug session: `reply = await executor.clearBreakpointViaGdb(fileFullPath, line)`. The note is `RM3` when the echo check matches, else `RM4`. Without a session there is no note.
- Return `RM2` with the note.

#### `handleClearAllBreakpoints`

- No arguments. Not fenced, not gated (known bug KB3). Any error throws `CL5` with `String(error)`.
- Count `executor.getBreakpoints().length`, then call `executor.clearAllBreakpoints()` (synchronous).
- With a debug session: `reply = await executor.clearAllBreakpointsViaGdb()`. The note is `CL3` when the echo check matches, else `CL4`.
- Count 0 and no note: return `CL1`. Otherwise return `CL2` with the count and the note. With a session and count 0 this gives `Cleared 0 breakpoint(s) …`.

#### `handleListBreakpoints`

- No arguments. Not fenced. Any error throws `LB5` with `String(error)`.
- `executor.getBreakpoints()` empty: return `LB1`.
- Otherwise `LB2`, then one line per breakpoint with the 1-based index over all breakpoints:
  - `vscode.SourceBreakpoint`: `LB3`, where the base name is the last segment of `location.uri.fsPath` split on `/` or `\`, and the line is `range.start.line + 1`.
  - `vscode.FunctionBreakpoint`: `LB4`.
  - Other kinds print nothing, but still use up an index (known bug KB15).
  - The modifiers come from `formatBreakpointModifiers(bp)`. Every line, the last one included, ends with a line feed.

#### `handleListVariableNames`

- Fenced `list_variable_names`. `scope` defaults to `all`. Gate `list variable names`.
- Frame: `vscode.debug.activeStackItem` must exist and have a `frameId` property (a stack frame, not a thread), else throw `V1`.
- `executor.getVariables(frameId, scope, timeoutMs)`. When `scope` is `global` and `scopes` is missing or empty, call again with `all` (the "global fallback").
- No scopes: return `V2`. Otherwise return `renderVariableNames(scopes, { maxVariables: DEFAULT_NAME_LISTING_LIMIT })` from `src/core/variableView.ts`.

#### `handleGetVariables`

- Fenced `get_variables_values`. `scope` defaults to `all`. Gate `read variables`.
- Frame and scopes as for `handleListVariableNames`, including the global fallback. No scopes: return `V2`.
- When `variableNames` is non-empty, filter with `selectVariables(scopes, variableNames)`, which also gives the missing names. An empty array counts as not given.
- The output starts with `V3` if the global fallback was used.
- `variableNames` given and nothing selected: return the output + `V4`.
- Otherwise the output + `renderScopes(selected, { header: 'Variables', redact: the redaction callback or undefined, limits })` + `formatMissingNames(missing)`. `limits` is `DEFAULT_LISTING_LIMITS` when no names were given, else undefined.

#### `handleEvaluateExpression`

- Fenced `evaluate_expression`. Gate `evaluate expression`. Frame as above (`V1`).
- `response = await executor.evaluateExpression(expression, frameId, timeoutMs)`. A missing response or `response.result === undefined` throws `E4`. `null` is a result.
- GDB passthrough: the expression, with leading whitespace removed, starts with `-exec`.
- Value: with redaction on and no passthrough, `redactExpressionResult(expression, response.result)`; otherwise `String(response.result)`, not redacted.
- Output: `E1` on its own line, then `E2`, then `E3` when `response.type` is truthy, then a blank line and `REDACTION_NOTICE` when the value was redacted.

#### `handleReadMemory`

- Fenced `read_memory`. `format` defaults to `hex`. Gate `read memory`.
- `data = await executor.readMemory(address, length, timeoutMs)`, with the address exactly as given.
- Then the display address: the address text, with `0x` prepended unless it starts with `0x` or `0X`, is parsed as a big integer. A decimal address is therefore shown as if it were hex, and a malformed one fails here with the `BigInt` error through the fence (known bug KB13).
- Output:
  - `MEM1`, with the requested `length`, not the number of bytes returned (known bug KB13).
  - `hex` or `both`: `MEM2`, then one `MEM3` row per 16 bytes. The row address is base + offset in lower-case hex, zero-padded to 8 digits; the bytes are two-digit lower-case hex separated by single spaces.
  - `ascii` or `both`: `MEM4`, then one character per byte (0x20–0x7E as themselves, anything else `.`). After every 64th byte a line feed and two spaces are inserted. A final line feed follows.
  - With `both`, the hex part comes first.

#### `handleReadCoreRegisters`

- Fenced `read_core_registers`. Gate `read core registers`. `regs = await executor.readCoreRegisters(timeoutMs)` (all registers, no name list).
- Values: a missing or empty value is `<?>`. Normalisation applies everywhere except `xpsr` and `control`, which are printed raw.
- Output, each line ending with a line feed:
  - `REG1`.
  - Four rows for `r0 r1 r2 r3`, `r4 r5 r6 r7`, `r8 r9 r10 r11` and `r12 sp lr pc`. Each row is two spaces followed by four cells. A cell is the register name padded right to 4 characters, then `=` and a space, then the normalised value padded right to 14 characters, so every row ends with padding.
  - Then `REG2` to `REG8`.

#### `handleReadCycleCounter`

- Fenced `read_cycle_counter`. Gate `read cycle counter`. `reading = await executor.readCycleCounter(timeoutMs)`, which returns `{ cycles, enabledNow, present }`.
- Not present: return `CYC1`.
- Otherwise `CYC2` (the cycles in decimal, and in lower-case hex zero-padded to 8 digits), then `CYC3` if `enabledNow`, then `CYC4`, `CYC5` and `CYC6`.

#### `handleReadPeripheralRegister`

Fenced `read_peripheral_register`, gate `read peripheral register`. Returns `await executor.readPeripheralRegister(peripheral, register, timeoutMs)` verbatim.

#### `handleGetFaultInfo`

Fenced `get_fault_info`, gate `read fault info`. Returns `await executor.getFaultInfo(timeoutMs)` verbatim.

#### `handleDiagnoseFault`

- Arguments may be omitted. Fenced `diagnose_fault`. Gate `diagnose the fault`. Every step after the first degrades to a note instead of failing.
  1. `decodeFault(await executor.readFaultRegisters(timeoutMs))`. A failure here fails the call (fence text).
  2. `executor.readCoreRegisters(timeoutMs, ['sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'msplim', 'psplim'])`. On failure, add `core registers` to the skipped list and use no values. `control` is requested but unused. Numeric values are formed for `sp lr pc xpsr msp psp msplim psplim`; a decoded `xpsr` becomes undefined.
  3. `selection = selectExceptionFrame(lr, msp, psp)`:
     - Not `isExcReturn`: frame note `DF1` when LR is undefined, else `DF2`.
     - `sp` null: frame note `DF3`.
     - Otherwise `parseStackedFrame(await executor.readExceptionFrame(sp, timeoutMs))`. A null parse gives frame note `DF4`. A failure adds `exception frame` to the skipped list.
  4. `executor.getCallStack(undefined, levels ?? 3, timeoutMs)`. A failure adds `call stack` to the skipped list and uses no frames.
  5. `loadSvdForLookup({})`. No device: SVD note `DF5`. A failure: SVD note `DF6`.
  6. Fault address: `classifyAddress(decoded.faultAddress.value, device)` when the decoded fault has one. PC info: `classifyAddress(frame.pc ?? regs.pc, device)` when defined.
  7. Stop reason: `getStoppedReason(session)` for `resolveActiveSession()`, else null.
- Return `renderDiagnosis({ decoded, frame, selection, regs, faultAddress, pcInfo, stopReason, frames, frameNote, skipped, svdNote, maxFrames: levels ?? 3 })` from `src/core/faultTriage.ts`. Frame sources are shortened with `shortenPath(source, workspace folder paths)`. The skipped list keeps the order above.

#### `handleLookupPeripheral`

- Arguments may be omitted. Fenced `lookup_peripheral`. No session needed and no gate.
- `loadSvdForLookup({ svdFile, pname })`. No device: return `SVD1` with the `tried` list.
- Otherwise, the first that applies:
  1. `address` given and non-empty: `parseAddress(address)`. Null: return `SVD2`. Else return `renderAddressHit(addr, lookupAddress(device, addr), device.name)`.
  2. `name` truthy: `matchName(listPeripheralNames(device), name)`. The peripheral is `findPeripheral(device, exact)` when there is an exact match. Missing: return `SVD3` (with suggestions when there are any). Else return `renderPeripheral(peripheral, { filter })`.
  3. Otherwise return `renderPeripheralList(device, { filter })`.

#### `handleLookupRegister`

- Fenced `lookup_register`. No gate. SVD as above: no device returns `SVD1`.
- Peripheral: `matchName(listPeripheralNames(device), peripheral ?? '')`, then `findPeripheral`. Missing: return `SVD3` with the requested name.
- Register: `matchName` over the names of the peripheral's `registers` with `register ?? ''`, then `findRegister`. Missing: return `SVD4`.
- Return `renderRegister(peripheral, register)`.

#### `handleGetDeviceInfo`

- No arguments. Not fenced, no run-state requirement. Any error throws `DI3` with `String(error)`.
- `executor.hasDebugSession()` false: throw `DI1`.
- `info = await executor.getDeviceInfo()`, then query the active target. With a name, return `DI2`; otherwise return `info` unchanged.

#### `handleCheckTargetConnection`

- No arguments. Not fenced. Returns `await executor.checkTargetConnection()` verbatim; with no session the executor returns `No active debug session.`.
- A `HardwareTimeoutError`: return `TC1`. Any other error: throw `TC2`.

#### `handleGetSessionStatus`

- No arguments. Not fenced, no wrapper: the executor's `getSessionStatus` is designed never to throw.
- Lines joined with a line feed:
  1. `SS1`.
  2. `SS2`, `SS3`, `SS4`, each only when its field is truthy.
  3. `SS5`, with the probe part only when `dapProbeMs` is not null.
  4. `SS6` when `detail` is truthy.
  5. `SS7` from `executor.getDiagnostics()`. The name list appears only when non-empty; `set` / `undefined` reflects `hasVscodeActiveSession`.
  6. One hint by state: `no-session` gives `SS8` when `liveSessionCount` is 0, else `SS9`; `initializing` `SS10`; `running` `SS11`; `stopped` `SS12`; `unresponsive` `SS13`.
- The MCP server appends its tool-stats trailer afterwards; that is not this module.

#### `handleGetCallStack`

- Fenced `get_call_stack`. Gate `get call stack`.
- `frames = await executor.getCallStack(threadId, levels ?? 50, timeoutMs)`. Empty: return `CS1`.
- When `levels` is given, all frames are shown. Otherwise `truncateList(frames, 20)`.
- Lines joined with a line feed:
  1. `CS2`, with `frame` singular for exactly one.
  2. One `CS3` per shown frame. The index is zero-based, left-padded with spaces to width 2. The location is `⟨shortenPath(source, roots)⟩:⟨line or ?⟩`, or `<no source>:⟨line or ?⟩`. The id part appears when `frameId` is defined. `roots` are the workspace folder paths.
  3. `CS4` if frames were hidden.
  4. An empty line, then `CS5`.
- `test/realboard/run.ts` extracts `frameId=(\d+)` from this output.

#### `handleGetThreads`

- Fenced `get_threads`. Gate `get threads`.
- `threads = await executor.getThreads(timeoutMs)`. Empty: return `TH1`.
- `truncateList(threads, 32)`. Lines joined with a line feed:
  1. `TH2`.
  2. One `TH3` per shown thread. The top-frame part appears when the thread has `topFrame`, with its source shortened or `<no source>`, and its line or `?`.
  3. `TH4` if threads were hidden.
  4. An empty line, then `TH5`.

#### `handleGetFrameVariables`

- Fenced `get_frame_variables`. `scope` defaults to `all`. Gate `get frame variables`.
- `executor.getVariablesForFrame(frameId, scope, timeoutMs)`. There is no global fallback and no active-frame check. No scopes: return `FV1`.
- Selection as for `get_variables_values`. Names given and nothing selected: return `FV2`.
- Otherwise return `renderScopes(selected, { header: FV3, redact, limits })` + `formatMissingNames(missing)`, with limits as for `get_variables_values`.

#### `handleCmsisCommand`

- Arguments: `action`, `target?`, `timeoutMs?`.
- "Build-class" actions are `build`, `load`, `erase` and `load_and_run`. The effective timeout is `timeoutMs` when positive, else 60 000 for build-class actions and 30 000 for the others. The fence is `cmsis_action` with the effective timeout, which the fence clamps to 60 000.
- Inside the fence, in order:
  1. `load_and_debug` or `attach` while `executor.hasDebugSession()`: read `getSessionStatus()` and return `CA1`.
  2. Query the active solution. Not active: return `CA2` with its description and `getDiagnostics().serverVersion`.
  3. Query the active target (its name, possibly none). `target` given but `parseTargetRef(target)` returns nothing (empty, blank or `@…`): return `CA3`.
  4. A reference that does not match the active target (`targetMatches`):
     - With a debug session: return `CA4`. This applies to every action.
     - Otherwise run the target switch with the solution path. Failure: return `CA15` with the reason. Success: remember the previous name (or `(none)`) and use the new one.
  5. Target tag: when a target is active, a space and `on ⟨active⟩`, followed after a switch by `, switched from ⟨previous⟩`; empty when no target is active. The tag is embedded where the `CA` texts show `⟨tag⟩`.
  6. Command map: `build` → `cmsis-csolution.build`, `load` → `cmsis-csolution.cmsisLoad`, `erase` → `cmsis-csolution.cmsisErase`, `load_and_run` → `cmsis-csolution.cmsisLoadAndRun`, `load_and_debug` → `cmsis-csolution.cmsisLoadAndDebug`, `attach` → `cmsis-csolution.cmsisAttachDebugger`, `detach` → `cmsis-csolution.cmsisDetachDebugger`, `stop_run` → `cmsis-csolution.cmsisStopRun`. An unknown action throws `CA16`, which the fence returns; it is detected only here, after the checks above (known bug KB17).
  7. Build-class actions only: arm the task waiter now, after any switch, with budget max(5 000, effective timeout − 3 000).
  8. `vscode.commands.executeCommand(command)` with no arguments. It is not awaited to completion. A rejection is recorded: a message matching `no active solution` (case-insensitive) records `CA5`; anything else records `CA6` with `String(error)` and the diagnostics suffix.
  9. Kick-off: wait until the command settles or 4 s pass, whichever comes first. A quickly resolving command (for example `detach`) returns at once. If a rejection was recorded by then, throw it; the fence returns it as `F2`. A rejection that arrives later is dropped (known bug KB11).
  10. `load_and_debug` / `attach`: wait for a live session with override 8 000.
      - Live: run the survival probe. Stable: `getCurrentDebugState(3)` and return `CA12` with the full state. Unstable: return `CA13` + the diagnostics suffix.
      - Not live: return `CA14`.
  11. Build-class: await the task waiter.
      - Done with exit code 0: return `CA7` + the next-step text for the action (`CA7a` to `CA7d`).
      - Done with a numeric code: return `CA8`.
      - Done without a code: return `CA9`.
      - Not started: return `CA10`.
      - Started but not ended: return `CA11`, with the waited seconds = round(max(5 000, effective timeout − 3 000) / 1 000) and the task name, or the command id when there is no name.
  12. `detach` / `stop_run`: return `CA17`.

#### `handleFlash`

- Arguments: `cbuildRunFile?`, `timeoutMs?`. Fenced `flash` with `timeoutMs ?? 60000`. The fence still clamps to 60 000, and a `timeoutMs` of 0 gets the 30 s fence default.
- In order:
  1. `executor.hasDebugSession()`: return `FL1`.
  2. cbuild-run resolution; an error text is returned as is.
  3. `version = await probePyocd()` (its default 5 s). No version: return `FL6`.
  4. Programming budget = max((`timeoutMs ?? 60000`) − 1 500, 1 000). Call `flashWithPyocd(path, budget)` from `src/core/flashController.ts`.
- Result:
  - `timedOut`: return `FL7` with the budget in whole seconds (rounded) and the output tail, or `<no output>`.
  - `ok`: return `FL8`. The byte part appears when `programmedBytes` is not null, the rate part when `kbps` is not null; the version and `commandLine` are included.
  - Otherwise return `FL9`, with the exit code or `unknown`, the error-lines block only when there are error lines, and the output tail or `<no output>`.

## Agent-visible text

Notation:

- Each entry below is `ID: text`. The ID and the colon-space after it are not part of the text.
- `⟨…⟩` is a placeholder; everything else is literal.
- `\n` is a line feed. No fixed text contains a backslash, so `\n` is unambiguous.
- Where a text starts with spaces, they are significant.
- The emoji are exact: `⚠️` is U+26A0 U+FE0F, `ℹ️` is U+2139 U+FE0F, `✅` is U+2705, `❌` is U+274C and `🩹` is U+1FA79; the last three carry no variation selector. Dashes are U+2014 (—), the ellipsis is U+2026 (…) and the arrow is U+2192 (→).
- `[REWORD]` entries are strings still shared with DebugMCP. The rewrite phrases them anew with the same meaning. Placeholders, tool names and identifiers inside them stay as they are. Every other entry is reproduced byte for byte.

Texts produced by other modules (renderers in `src/core/*`, `REDACTION_NOTICE`, executor pass-through replies) are not listed; this module embeds them unchanged.

### Fence, gate, diagnostics

```text
F1: '⟨label⟩' did not complete within ⟨ms⟩ ms (handler-level cap). The DAP probe or target may be unresponsive — call get_session_status / check_target_connection to confirm. Note: the underlying request may still be running on the server; consider restart_debugging if subsequent calls also stall.
F2: Error in '⟨label⟩': ⟨message⟩
G1: Cannot ⟨operation⟩: session state is '⟨state⟩'. ⟨hint⟩ Use get_session_status for a definitive, never-failing classification.
G2: No active debug session. Call start_debugging first.
G3: The debug adapter is still starting. Wait briefly and retry; the session has not torn down.
G4: The target is currently running. Add a breakpoint or wait for the previous continue/step to stop before issuing another inspection or step command.
G5: The probe/GDB server is unresponsive. Call check_target_connection to confirm, then restart_debugging or stop_debugging.
G6: Session reports stopped — please retry the operation.
D1: \nRecent adapter traffic (last ⟨count⟩ lines):\n  ⟨lines joined with "\n  "⟩
```

### Session start, stop, restart, reset

```text
ST1: A debug session is already active (name='⟨sessionName, or ? when null⟩', state=⟨state⟩). Refusing to start a second session. Use stop_debugging first, or call restart_debugging to reuse the current session, or proceed directly with inspection tools (get_variables_values, read_memory, …).
ST2: Debug session started successfully for: ⟨target⟩ using configuration '⟨configuration⟩'. Current state: ⟨full state⟩
ST3: Debug session started successfully for: ⟨fileFullPath⟩⟨ST4 or ST5⟩⟨ST11 or nothing⟩. Current state: ⟨full state⟩
ST4:  using configuration '⟨configuration⟩'
ST5:  with default configuration
ST6: Debug session started but failed to become active within timeout period
ST7: Failed to start debug session with configuration '⟨configuration⟩'.
ST8: fileFullPath is required when no named configuration is provided.
ST10: Error starting debug session: ⟨String(error)⟩⟨D1 or nothing⟩
RS2: Debug session restart issued but target did not become ready within the ⟨timeoutInSeconds⟩s timeout. The probe or target may be unresponsive.
RE1: No active debug session. Start debugging first — reset drives the target through the live probe.
```

`ST4` and `ST5` start with one space.

- `ST11` [REWORD]: the fragment appended after the configuration part when `testName` is given. It names the test being debugged and contains `⟨testName⟩`. It starts with a space.
- `ST9` [REWORD]: thrown when `executor.startDebugging` returns false. Meaning: the debug session could not be started; make sure the extension that debugs this kind of file is installed.
- `SP1` [REWORD]: returned by `stop_debugging` without a session. Meaning: there is no active debug session, so there is nothing to stop.
- `SP2` [REWORD]: first line of a successful stop. Meaning: the debug session was stopped.
- `SP3` [REWORD]: the reminder after `SP2`, several lines of Markdown. Meaning:
  - A warning-marked heading, "root cause analysis checkpoint".
  - Before concluding, ask whether the root cause or only a symptom was found.
  - Knowing only *where* it went wrong (a null or undefined variable, an unexpected return value, an error at a specific line, a wrongly evaluated condition) most likely means a symptom was found, so keep debugging.
  - The root cause is *why* it happened, for example wrong initialisation, a logic error in a function, missing error handling, or faulty assumptions in conditions.
  - Required next steps, numbered: use `add_breakpoint` at investigation points; use `start_debugging` to trace from the beginning; investigate why, not just what; repeat until the root cause is identified.
- `SP4` [REWORD]: the wrapper around any `stop_debugging` failure. Meaning: stopping the debug session failed. It is followed by `: ⟨String(error)⟩`.
- `RS1` [REWORD]: thrown inside `restart_debugging` without a session. Meaning: there is no active debug session to restart.
- `RS3` [REWORD]: returned after a successful restart. Meaning: the debug session was restarted.
- `RS4` [REWORD]: the wrapper around any `restart_debugging` failure. Meaning: restarting the debug session failed. It is followed by `: ⟨String(error)⟩`; the snapshot today shows `⟨RS4⟩: Error: ⟨RS1⟩`.

### Motion, pause, wait

```text
M1: Target stopped (reason: ⟨reason⟩).\n\n⟨compact state⟩
M2: \n\n⚠️ Debug session ended during '⟨op⟩'. The target may have run to completion, crashed, or lost its connection.
M3: \n\n⚠️ '⟨op⟩' did not complete within ⟨timeoutInSeconds⟩s. The target is still running or the probe is unresponsive. Consider adding a breakpoint, checking the hardware connection, or calling check_target_connection.
M4: \n🩹 Recovery attempt: target did not stop on its own — issuing DAP pause to find out where it is.
M5: Pause issued but the debug session ended. The target may have crashed during '⟨op⟩'.
M6: Pause did not produce a stop event within 5s — probe/GDB server may be unresponsive. Call check_target_connection, then restart_debugging if needed.
M7: Paused successfully. PC = ⟨pc⟩⟨M7a or nothing⟩⟨M7b or nothing⟩⟨M7c or nothing⟩.
M7a: , LR = ⟨lr⟩
M7b:  in ⟨frameName⟩
M7c:  at ⟨fileName⟩:⟨currentLine⟩
M8:   Current line: ⟨currentLineContent⟩
M9: The breakpoint you expected was not hit — the firmware did not reach it. Verify the breakpoint location, check the call stack with get_call_stack, or step from here with step_over / continue_execution.
M10: Pause failed: ⟨message⟩. Probe / GDB server may be wedged — call check_target_connection.
P1: No active debug session. Start debugging first.
P2: Target is already stopped (reason: ⟨detail, or n/a⟩). No pause needed — proceed with inspection tools.
P3: Cannot pause: probe/GDB server is unresponsive. Call check_target_connection or restart_debugging.
P4: No active debug session.
P5: Cannot pause yet: session is still initializing. Wait briefly and retry.
P6: Pause requested but target did not stop within the timeout. Probe may be unresponsive — call get_session_status / check_target_connection.
P7: Pause requested but the debug session ended. The target may have crashed.
P8: Target paused. ⟨compact state⟩
W1: No active debug session. Start debugging first — wait_for_stop waits on a live session.
W2: Target did not stop within the timeout — it is still running (or the probe is unresponsive). Options: call wait_for_stop again with a larger timeoutMs, pause_execution to see where it is, or check_target_connection if other calls are also stalling.
W3: The debug session ended while waiting for a stop — the target may have crashed, the probe disconnected, or the session was stopped in the UI. Call get_session_status to confirm.
W4: Target was already stopped (reason: ⟨reason, or unknown⟩).\n\n⟨compact state⟩
W5: Target stopped (reason: ⟨reason, or unknown⟩⟨W5a or nothing⟩).\n\n⟨compact state⟩
W5a: , threadId=⟨threadId⟩
```

`M7b`, `M7c` and `M8` start with one, one and two spaces respectively. In `M7`, `⟨pc⟩` is the normalised PC, `<unavailable>`, or `<read failed: ⟨message⟩>`.

- `M11` [REWORD]: the wrapper around any `step_over` failure. Meaning: executing step over failed. It is followed by `: ⟨String(error)⟩`.
- `M12` [REWORD]: the same for `step_into` (step into).
- `M13` [REWORD]: the same for `step_out` (step out).
- `M14` [REWORD]: the same for `continue_execution` (continue).

### Breakpoints and logpoints

```text
BP1: Invalid line number ⟨line⟩: must be a 1-based integer.
BP2: No location given: pass `line` (1-based line number). The legacy `lineContent` form is still accepted but deprecated.
BP3: Could not find any lines containing: ⟨lineContent⟩
BP4: Breakpoint added at ⟨fileFullPath⟩:⟨line⟩⟨BP6 or nothing⟩
BP5: Breakpoints added at ⟨count⟩ locations in ⟨fileFullPath⟩: lines ⟨lines joined with ", "⟩⟨BP6 or nothing⟩
BP6:  [when: ⟨condition⟩]
BP7: \n⚠️ Located via the deprecated `lineContent` match (⟨count⟩ line(s) matched). Pass `line` instead — content matching hits every line containing the text.
BP8: \n(No debug session yet — added to the breakpoint list. It will be GDB-bound when you add it again after the session is up, or re-add after attach.)
BP9: line ⟨line⟩: ⟨reply, or <no echo from adapter — normal>⟩ [⟨bound|rejected|unconfirmed⟩]
BP10: \n⚠️ GDB rejected one or more breakpoints:\n  ⟨BP9 entries joined with "\n  "⟩\n"No source file" / "No line" means the path does not match the ELF's compiled paths — try the path as the compiler saw it, or set by function name via evaluate_expression ("-exec break <function>").
BP11: \nGDB confirmed binding:\n  ⟨BP9 entries joined with "\n  "⟩
BP12: \nSent to GDB (`break`). The adapter did not echo a confirmation — this is normal for gdbtarget and does NOT mean it failed. The breakpoint is set; verify by running continue_execution (the target should stop) or list_breakpoints.\n  ⟨BP9 entries joined with "\n  "⟩
BP13: Error adding breakpoint: ⟨String(error)⟩
LP1: Logpoint added at ⟨fileFullPath⟩:⟨line⟩
LP2: \n(No debug session yet — added to the breakpoint list. Re-add after the session is up so it is bound GDB-native via `dprintf`.)
LP3:   GDB: dprintf ⟨fileFullPath⟩:⟨line⟩,"⟨format⟩"⟨"," + args joined with ",", or nothing⟩
LP4: ⚠️ GDB rejected the logpoint: ⟨reply⟩
LP5: Check that the path matches the ELF's compiled paths, and that every interpolated expression is in scope at that line.
LP6:   Condition applied to GDB breakpoint ⟨number⟩: ⟨condition⟩⟨" — " + condReply when condReply is non-empty⟩
LP7: ⚠️ Condition "⟨condition⟩" was set on the VS Code breakpoint but NOT on the GDB dprintf: the adapter did not echo a breakpoint number to attach it to. The logpoint will fire unconditionally. Apply it manually with evaluate_expression("-exec condition <n> ⟨condition⟩") after finding <n> via evaluate_expression("-exec info breakpoints").
LP8: \nℹ️ On Cortex-M a logpoint is not free: the core halts on every hit while GDB formats and prints, then resumes. In a hot loop or an ISR this distorts timing far more than it would in a host process. For high-rate tracing prefer read_cycle_counter around the region, or have the firmware fill a RAM buffer you read with read_memory.
LP10: Unbalanced '{' in logMessage at position ⟨index⟩. Use {{ for a literal brace.
LP11: Empty interpolation '{}' in logMessage at position ⟨index⟩.
LP12: Unbalanced '}' in logMessage at position ⟨index⟩. Use }} for a literal brace.
RM2: Breakpoint removed from ⟨fileFullPath⟩:⟨line⟩⟨RM3, RM4 or nothing⟩
RM3: \nGDB `clear ⟨fileFullPath⟩:⟨line⟩` issued — ⟨reply⟩
RM4: \nGDB `clear ⟨fileFullPath⟩:⟨line⟩` issued.
CL2: Cleared ⟨count⟩ breakpoint(s) from the model.⟨CL3, CL4 or nothing⟩
CL3: \nGDB `delete` issued — ⟨reply⟩
CL4: \nGDB `delete` issued — all GDB-native breakpoints removed.
LB3: ⟨index⟩. ⟨baseName⟩:⟨line⟩⟨modifiers⟩\n
LB4: ⟨index⟩. Function: ⟨functionName⟩⟨modifiers⟩\n
```

`BP6` starts with one space; `LP3` and `LP6` with two.

- `LP9` [REWORD]: the wrapper around any `add_logpoint` failure. Meaning: adding the logpoint failed. It is followed by `: ⟨String(error)⟩`.
- `RM1` [REWORD]: returned when the model has no breakpoint at the location. Meaning: no breakpoint exists at `⟨fileFullPath⟩:⟨line⟩`; keep that `path:line` form. The snapshot pins today's text with `/nonexistent/main.c:1`.
- `RM5` [REWORD]: the wrapper around any `remove_breakpoint` failure. Meaning: removing the breakpoint failed. It is followed by `: ⟨String(error)⟩`.
- `CL1` [REWORD]: returned when there is nothing to clear. Meaning: there are no breakpoints to clear.
- `CL5` [REWORD]: the wrapper around any `clear_all_breakpoints` failure. Meaning: clearing breakpoints failed. It is followed by `: ⟨String(error)⟩`.
- `LB1` [REWORD]: returned when the list is empty. Meaning: no breakpoints are set.
- `LB2` [REWORD]: the header line of the list, followed by a line feed. Meaning: the breakpoints that are set.
- `LB5` [REWORD]: the wrapper around any `list_breakpoints` failure. Meaning: listing breakpoints failed. It is followed by `: ⟨String(error)⟩`.

### Variables and expressions

```text
V3: Note: No dedicated "Global" scope is available from this debug adapter. Showing all available scopes instead. Use evaluate_expression to inspect specific global variables by name.\n\n
V4: None of the requested variables are in scope: ⟨variableNames joined with ", "⟩.\nCall list_variable_names to see what is available here.
FV1: No variable scopes available for frameId=⟨frameId⟩.
FV2: None of the requested variables are in scope at frameId=⟨frameId⟩: ⟨variableNames joined with ", "⟩.
FV3: Variables for frameId=⟨frameId⟩
E2: Result: ⟨value⟩
```

The `renderScopes` header for `get_variables_values` is the literal `Variables`.

- `V1` [REWORD]: thrown when `vscode.debug.activeStackItem` is not a stack frame. Meaning: there is no active stack frame; execution must be paused at a breakpoint.
- `V2` [REWORD]: returned when the frame has no scopes. Meaning: no variable scopes are available at the current execution point.
- `E1` [REWORD]: the first line of an evaluation result, followed by a line feed. It echoes the evaluated expression and contains `⟨expression⟩`.
- `E3` [REWORD]: appended to `E2` when the adapter reports a type. It shows `⟨type⟩`; today it is a space plus the type in parentheses.
- `E4` [REWORD]: thrown when the adapter returns no result. Meaning: the expression could not be evaluated.

### Memory, registers, cycle counter

```text
MEM1: Memory at ⟨address with 0x prefix⟩ (⟨length⟩ bytes):\n
MEM2: \nHex:\n
MEM3:   0x⟨row address, 8+ lower-case hex digits⟩: ⟨bytes⟩\n
MEM4: \nASCII:\n  ⟨characters⟩\n
REG1: Core Registers:
REG2:   xpsr = ⟨raw xpsr or <?>⟩
REG3:   msp  = ⟨value⟩
REG4:   psp  = ⟨value⟩
REG5:   control   = ⟨raw control or <?>⟩
REG6:   faultmask = ⟨value⟩
REG7:   basepri   = ⟨value⟩
REG8:   primask   = ⟨value⟩
CYC1: This core reports no DWT cycle counter (DWT_CTRL.NOCYCCNT=1) — read_cycle_counter is unavailable. Use an RTOS tick or a timer peripheral for timing instead.
CYC2: DWT cycle counter: ⟨cycles⟩ (0x⟨cycles, 8+ lower-case hex digits⟩)\n
CYC3: DWT was enabled during this call — deltas are valid from now.\n
CYC4: Wrap: 32-bit, wraps every 2^32 cycles (~10.7 s @ 400 MHz) — for longer spans, sample repeatedly and accumulate.\n
CYC5: Note: CYCCNT stops while the core is halted and during WFE sleep — it counts ACTIVE cycles only.\n
CYC6: To time a region: read here, continue_execution / wait_for_stop to the end point, read again, subtract (mod 2^32).
```

`MEM3` and `REG2`–`REG8` start with two spaces. The register output ends `REG2` … `REG8` in that order, `REG8` included, each followed by a line feed. In `MEM4` the characters are broken by a line feed and two spaces after every 64th byte.

### Fault diagnosis, SVD lookups, device, connection

```text
DF1: LR unavailable — read_core_registers, then read_memory at PSP/MSP
DF2: LR is not an EXC_RETURN value — halted deeper inside the handler; get_call_stack has the frames
DF3: ⟨PSP or MSP⟩ unavailable — read_core_registers
DF4: short read at ⟨PSP or MSP⟩
DF5: no SVD found — addresses are classified by the Cortex-M system map only; pass svdFile to lookup_peripheral to resolve them
DF6: SVD could not be loaded
SVD1: No SVD file found for a lookup.⟨"\nTried:\n  - " + tried joined with "\n  - ", or nothing when the list is empty⟩\nPass svdFile (the device .svd from the DFP; ${CMSIS_PACK_ROOT} is expanded), or build the solution so out/<context>.cbuild-run.yml names it, or add "svdFile" to the launch configuration. For a multi-core device pass pname to pick the core.
SVD2: '⟨address⟩' is not an address — pass hex like 0x40005400 or a decimal number.
SVD3: Peripheral '⟨requested name⟩' is not in the SVD of ⟨device name⟩.⟨" Did you mean: " + suggestions joined with ", " + "?", or nothing⟩\nCall lookup_peripheral without name for the full list.
SVD4: Register '⟨requested register⟩' is not in ⟨peripheral name⟩.⟨" Did you mean: " + suggestions joined with ", " + "?", or nothing⟩\nCall lookup_peripheral { name: '⟨peripheral name⟩' } for its register map.
DI1: No active debug session. Start debugging first.
DI2: ⟨device info with trailing whitespace removed⟩\n  CMSIS target: ⟨active target⟩
DI3: Error getting device info: ⟨String(error)⟩
TC1: check_target_connection: ⟨HardwareTimeoutError message⟩
TC2: Error checking target connection: ⟨String(error)⟩
```

Skipped-section names for `diagnose_fault`: `core registers`, `exception frame`, `call stack`. The `${CMSIS_PACK_ROOT}` in `SVD1` is literal text.

### Call stack and threads

```text
CS1: No stack frames available.
CS2: Call stack (⟨count⟩ frame⟨s unless count is 1⟩):
CS3:   #⟨index padded to width 2⟩  ⟨frame name⟩  @ ⟨location⟩⟨" [frameId=" + frameId + "]", or nothing⟩
CS4:   … ⟨hidden⟩ more frames — pass levels to see all
CS5: Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.
TH1: No threads reported by the debug adapter.
TH2: Threads / RTOS tasks (⟨count⟩):
TH3:   [⟨id⟩] ⟨name⟩⟨"  → " + top frame name + " @ " + source + ":" + line, or nothing⟩
TH4:   … ⟨hidden⟩ more threads
TH5: Tip: pass a threadId to get_call_stack to inspect a specific task.
```

`CS3`, `CS4`, `TH3` and `TH4` start with two spaces. `CS3` has two spaces around the frame name.

### Session status

```text
SS1: State: ⟨state⟩
SS2: Session: ⟨sessionName⟩
SS3: Type: ⟨sessionType⟩
SS4: Configuration: ⟨configurationName⟩
SS5: DAP responsive: ⟨true|false⟩⟨" (probe " + dapProbeMs + "ms)", or nothing⟩
SS6: Detail: ⟨detail⟩
SS7: Diagnostics: serverVersion=⟨serverVersion⟩, liveSessionsInThisWindow=⟨liveSessionCount⟩⟨" [" + names joined with ", " + "]", or nothing⟩, vscodeActiveDebugSession=⟨set|undefined⟩
SS8: Hint: no debug session is running in the VS Code window this call was routed to. Start one with cmsis_action load_and_debug (CMSIS targets) or start_debugging. If a session IS running and you expected to reach it, it is in a different window: call list_debug_windows to see which windows are registered and which one holds the session, then select_debug_window to pin it for this session. If you just reinstalled the extension, reload the window so the new build is active.
SS9: Hint: call start_debugging or cmsis_action load_and_debug to attach.
SS10: Hint: the adapter is still starting — wait a moment and retry.
SS11: Hint: target is running. Add a breakpoint then continue_execution, or call pause_execution to inspect now.
SS12: Hint: full inspection (variables, memory, registers) is available.
SS13: Hint: probe/GDB server is hung. Try restart_debugging, stop_debugging, or check the physical connection.
```

### CMSIS actions and target switch

```text
CA1: A debug session is already active (name='⟨sessionName, or ? when null⟩', state=⟨state⟩). Refusing to ⟨action⟩. Use stop_debugging or restart_debugging first, or proceed with inspection.
CA2: CMSIS '⟨action⟩' not attempted: the CMSIS Solution extension reports no active solution in this VS Code window (cmsis-csolution.getSolutionFile → ⟨description⟩). cmsis_action operates on whatever solution that extension has active — it cannot select one. Fixes: (1) open the folder containing the project's *.csolution.yml in the VS Code window running this MCP server (serverVersion=⟨serverVersion⟩); (2) in the CMSIS Solution panel, confirm a solution + active context is selected; (3) if the solution is open in a different window, drive cmsis_action from that window's MCP server.
CA3: CMSIS '⟨action⟩' not attempted: target '⟨target as given⟩' is not a valid reference — pass a target-type name or type@set as declared in the csolution, e.g. 'MPS3' or 'HP@debug'.
CA4: CMSIS '⟨action⟩' not attempted: the active target is '⟨active target, or (none)⟩' and switching to '⟨target as given⟩' re-activates the solution, which is not done under a live debug session. Call stop_debugging first, then repeat this call.
CA5: CMSIS '⟨action⟩' failed: no active CMSIS solution. The CMSIS Solution extension has no solution context in THIS VS Code window. Fixes:\n  1. Make sure the VS Code window running this MCP server (serverVersion=⟨serverVersion⟩) has the project's *.csolution.yml folder open — each window is independent.\n  2. In that window, open the CMSIS Solution panel and confirm a solution + active context is selected (Manage Solution).\n  3. If the solution is open in a different window, drive cmsis_action from that window's MCP server instead.\ncmsis_action operates on whatever solution the CMSIS Solution extension has active — it cannot select one for you.
CA6: CMSIS command '⟨command⟩' failed: ⟨String(error)⟩. Ensure the CMSIS Solution extension is installed and a solution context is active.⟨D1 or nothing⟩
CA7: ✅ CMSIS '⟨action⟩' succeeded⟨tag⟩ (task '⟨taskName⟩' exited 0).⟨CA7a–CA7d for the action⟩
CA7a:  The firmware is built — use cmsis_action load or load_and_debug to flash it.
CA7b:  Firmware flashed. Use cmsis_action attach or load_and_debug to start a debug session.
CA7c:  Target flash erased.
CA7d:  Firmware flashed and running (no debug session).
CA8: ❌ CMSIS '⟨action⟩' FAILED⟨tag⟩ — task '⟨taskName⟩' exited with code ⟨exitCode⟩. Open the CMSIS/cbuild terminal or the Problems panel to read the compiler/linker errors, fix them in the source, then re-run cmsis_action ⟨action⟩. This is a terminal result — do not wait for an output file.
CA9: CMSIS '⟨action⟩'⟨tag⟩ — task '⟨taskName⟩' ended without an exit code (it may have been cancelled). Re-run cmsis_action ⟨action⟩ to get a definite result.
CA10: CMSIS '⟨action⟩'⟨tag⟩ issued via '⟨command⟩', but no cbuild/flash task ran within the wait window. This usually means the active context is already up to date (nothing to ⟨action⟩), or the CMSIS Solution panel is showing a picker that needs manual selection. This is a terminal result — do not wait for an output file. Re-run the action or check the CMSIS panel.
CA11: CMSIS '⟨action⟩'⟨tag⟩ is still running after ⟨waited seconds⟩s (task '⟨taskName, or command⟩' has not finished). Large clean builds can take longer than this. The tool returned so you are not blocked — re-run cmsis_action ⟨action⟩ to get the final exit status, or watch the CMSIS terminal. Do NOT poll for an output file.
CA12: CMSIS '⟨action⟩' completed⟨tag⟩ — debug session survived the connect (⟨probe detail⟩). State: ⟨full state⟩
CA13: CMSIS '⟨action⟩'⟨tag⟩ started a debug session but it did NOT survive the initial connect — ⟨probe detail⟩. For 'attach' this almost always means no GDB server is listening on the configured port: start the GDB server first, or use 'load_and_debug' (which launches one). Confirm with get_session_status / check_target_connection.⟨D1 or nothing⟩
CA14: CMSIS '⟨action⟩'⟨tag⟩ issued via '⟨command⟩'. The flash/connect pipeline is running in the CMSIS extension (a multi-core flash + attach typically takes 20-40 s). This tool does not block for the whole pipeline — poll get_session_status until it reports 'running' or 'stopped'. If get_session_status keeps reporting 'no-session' with liveSessionsInThisWindow=0, the CMSIS panel is most likely showing a picker the user must resolve. Less often, this call and the poll landed in different windows — check with list_debug_windows and pin one with select_debug_window.
CA15: CMSIS '⟨action⟩' not attempted: ⟨switch reason⟩
CA16: Unknown CMSIS action: ⟨action⟩
CA17: CMSIS '⟨action⟩'⟨tag⟩ issued via '⟨command⟩'. It runs in the CMSIS extension — check the CMSIS output channel if you need to confirm.
TS1: Switch it by hand in the CMSIS Solution panel (Manage Solution → Target) and repeat the call.
TS2: the active target is '⟨was⟩' and the csolution path could not be resolved from the CMSIS Solution extension, so the target cannot be switched. ⟨TS1⟩
TS3: the active target is '⟨was⟩' and ⟨solution path⟩ could not be read (⟨message⟩). ⟨TS1⟩
TS4: ⟨resolution reason from resolveTargetSelection⟩. Active target: '⟨was⟩'. Declared targets: ⟨choices, or (none found)⟩.
TS5: could not write ⟨cmsis.json path⟩ to select '⟨resolved name⟩' (⟨message⟩). ⟨TS1⟩
TS6: wrote '⟨resolved name⟩' to ⟨cmsis.json path⟩ but re-activating the solution so the extension picks it up failed (⟨message⟩). ⟨TS1⟩
TS7: wrote '⟨resolved name⟩' to ⟨cmsis.json path⟩ and re-activated the solution, but the CMSIS Solution extension still reports '⟨last seen, or (none)⟩' as the active target after 15 s. ⟨TS1⟩
PR1: ⟨label⟩: no session object
PR2: ⟨label⟩: ⟨count⟩ thread(s)
PR3: ⟨label⟩: session object present but 0 threads — adapter is not connected to a target
PR4: ⟨label⟩: thread probe failed — ⟨message⟩
PR5: ⟨first detail⟩, ⟨second detail⟩ — target threads present
PR6: ⟨first detail⟩, then ⟨second detail⟩
```

`CA7a`–`CA7d` start with one space. `⟨tag⟩` is the target tag from step 5 of `handleCmsisCommand`: a space then `on ⟨active⟩` or `on ⟨active⟩, switched from ⟨previous⟩`, or nothing. The description in `CA2` is `none`, `query failed: …`, a path or `<active, path unknown>`. The reason in `CA15` is `TS2`–`TS7`. `CA1`–`CA4` and `CA15` are returned before any CMSIS command is executed.

### Flash

```text
FL1: Refusing to flash while a debug session is active — programming under a live session wedges most probes. Call stop_debugging first, then flash, then cmsis_action attach or load_and_debug.
FL2: cbuild-run file not found: ⟨resolved path⟩. Pass an existing path, or omit cbuildRunFile to auto-resolve from launch.json / out/.
FL3: No workspace folder open and no cbuildRunFile argument given — cannot resolve what to flash.
FL4: Found ⟨count⟩ cbuild-run files under out/ — pass cbuildRunFile explicitly:\n  ⟨paths joined with "\n  "⟩
FL5: No cbuild-run file found (launch.json has no resolvable cmsis.cbuildRunFile and out/ has none). Build first (cmsis_action build), or pass cbuildRunFile explicitly.
FL6: pyocd not found on PATH. Install it (pip install pyocd / pipx install pyocd), or use cmsis_action load, which drives the CMSIS Solution extension's own flash pipeline.
FL7: Flash timed out after ⟨budget in seconds⟩ s — the pyOCD process was killed.\nOutput tail:\n  ⟨tail joined with "\n  ", or <no output>⟩\nRetry, or investigate why programming stalls (probe connection, target held in reset).
FL8: ✅ Flash succeeded⟨" — programmed " + bytes + " bytes", or nothing⟩⟨" at " + kbps + " kB/s", or nothing⟩ (pyOCD ⟨version⟩: `⟨commandLine⟩`). Use cmsis_action attach or load_and_debug to start a debug session.
FL9: ❌ Flash FAILED (exit ⟨exitCode, or unknown⟩) — `⟨commandLine⟩`\n⟨"Errors:\n  " + error lines joined with "\n  " + "\n", or nothing⟩Output tail:\n  ⟨tail joined with "\n  ", or <no output>⟩\nThis is a terminal result — fix the cause and re-run flash.
```

### Markers other code depends on

- `src/core/toolMetrics.ts` `classifyOutcome` counts a result as a timeout when it contains `did not complete within` (from `F1` and `M3`), and as an error when a line starts with `Error in '` (from `F2`). Keep both.
- `test/realboard/run.ts` reads `frameId=(\d+)` (from `CS3`) and `State:\s*(stopped|running|initializing)` (from `SS1`).
- `test/transport/session-lifecycle.js` matches `CMSIS 'detach' on HE issued`, `CMSIS 'detach' on HP@release, switched from HE issued`, `CMSIS 'detach' on HP@release issued`, `not attempted.*'Nope' is not declared.*Declared targets: HE, HP@debug, HP@release` and `not attempted: wrote 'HP' to .*still reports 'HE'.*Manage Solution`, plus `No SVD file found.*Tried:` from `lookup_peripheral`.

## Known bugs to preserve

Each item is **preserve (fixed separately later)**. The rewrite reproduces it exactly, and the fix lands in its own commit.

- **KB1 (#11): fenced errors come back as text.** The 18 fenced methods return `F2` for any thrown error and `F1` on overrun as normal results (no `isError`). Refusals are returned as text too: `ST1`, `P2`/`P3`/`P5`–`P7`, `W2`/`W3`, `M3`, `FL1`/`FL6`/`FL7`/`FL9`, `CA1`–`CA4`, `CA8`, `CA10`, `CA11`, `CA13`–`CA15`. Unfenced wrappers re-wrap every error as a plain `Error` via `String(error)`, hence the doubled `…: Error: …` texts.
- **KB2 (#12): 60 s cap.** The fence clamps any `timeoutMs` to 60 s. `cmsis_action` build-class actions and `flash` default to the cap. The task-waiter budget is fixed when the waiter is armed, after the solution query and a possible target switch (up to 10 + 10 + 15 s), while the fence clock runs from entry, so the fence can fire first with the "DAP probe or target may be unresponsive" text. A `timeoutMs` above 60 000 (possible only over the control channel) still clamps the fence while the waiter and pyOCD budgets use the unclamped value. `CA11` tells the agent to re-run the action, which issues the command again.
- **KB3 (#13): breakpoint operations and restart are not gated on run state.** `add_breakpoint`, `add_logpoint`, `remove_breakpoint`, `clear_all_breakpoints` and `restart_debugging` check only that a session exists. A GDB "target is running" reply classifies as `unconfirmed` and is reported by `BP12` as "The breakpoint is set". The `clear` / `delete` notes (`RM4`, `CL4`) report success for any reply that fails the echo check.
- **KB4 (#46): probe guards.** `cmsis_action` guards only against a debug session (`CA1`, `CA4`). `load`, `erase` and `load_and_run` go straight to the command even while a CMSIS Run task holds the probe. `flash` spawns pyOCD from `PATH` with the same blind spot, and `FL6` recommends `pip install pyocd`. `stop_run` is fire-and-return (`CA17`).
- **KB5 (#47): task matching.** The CMSIS-task check lower-cases only the definition type: in the original, `.toLowerCase()` binds to the second string operand only, an operator-precedence slip. The `cmsis|cbuild` match is case-sensitive, so `CMSIS Load` / `Workspace` / `shell` never matches, and `load`, `erase` and `load_and_run` usually end in `CA10` after the whole wait. The waiter settles on the first matching process end of *any* execution (for example a `cbuild setup` started by the target switch's re-activation, or an earlier build). The remembered start name is never compared with the ending task. `CA10` claims "already up to date". `load_and_run` success is taken from a single task end. `load_and_debug` / `attach` report `CA13` when the second probe still sees 0 threads on a slow multi-core start.
- **KB6: GDB `-exec` passthrough.** The executor sends GDB commands as `-exec ⟨cmd⟩` evaluate requests, which the `gdbtarget` adapter may evaluate as C expressions instead. The handler builds on it:
  - the GDB-native `break` / `dprintf` / `clear` / `delete` steps;
  - classifying the adapter's generic reply as `unconfirmed` / "normal";
  - `evaluate_expression` exempting `-exec` expressions from redaction;
  - `BP10` and `LP7` recommending `-exec` commands.

  `add_logpoint` also creates both a model logpoint and a GDB `dprintf`, so a hit may print twice once the passthrough works.
- **KB7: Stale gate hints (#20).** `G2` names only `start_debugging` (not `cmsis_action load_and_debug` for CMSIS projects), and `G4` never names `pause_execution`.
- **KB8: Timeout texts name the setting, not the wait.** `M3` and `RS2` print `timeoutInSeconds` (default 180), while the real wait is at most 60 s or the per-call `timeoutMs`. With `timeoutMs: 5000` and the default setting, `M3` says "within 180s".
- **KB9: Ignored `timeoutMs`.** `start_debugging` and `restart_debugging` accept `timeoutMs` and ignore it; their session wait uses the configured timeout (capped at 60 s).
- **KB10: Session-wait overshoot.** The backoff sleep is not clipped to the budget. The 8 s opportunistic wait in `cmsis_action` can take about 15 s, and the default 60 s wait can run to about 65 s.
- **KB11: Late command failures are dropped.** A `cmsis-csolution.*` command that rejects after the 4 s kick-off is ignored; the call reports as if the command had been issued.
- **KB12: `remove_breakpoint` without a model entry.** It returns `RM1` and does not clear a GDB-native breakpoint that exists at that line.
- **KB13: `read_memory` header and address.** `MEM1` states the requested length, not the bytes returned. The address is parsed for display only after the read and always as hex, so a decimal address is shown as a different hex address, and a malformed one fails with a `BigInt` error through the fence.
- **KB14: Register normalisation edge cases.** The decimal parse accepts leading digits of mixed text. (The `0X…` and negative-decimal cases were fixed for 2.7.0: a `0X…` value drops its annotation like `0x…`, and a negative decimal is the register's two's complement, so `diagnose_fault` decodes the exception frame when GDB prints LR as `-7`.)
- **KB15: `list_breakpoints` numbering.** Breakpoint kinds other than source and function breakpoints print nothing but still use an index, which leaves gaps.
- **KB16: the switch refusal also blocks `detach` and `stop_run`.** Under a live debug session, a `target` that differs from the active one is refused (`CA4`) for every action, including `detach` and `stop_run`.
- **KB17: Unknown action detected late.** An unknown `action` (possible only over the control channel) is detected only after the solution and target checks, and possibly after a target switch.

## Test cases

Each case pins a behaviour of the new implementation. In the translation cases, `\n` inside a format value means a literal backslash followed by `n`.

### From the current unit test (to be rewritten from this list)

`src/test/debuggingHandler.test.ts` today. The execution cases use a fake executor that records calls:

- `hasDebugSession()` true, `hasActiveSession()` true, `getSessionStatus()` `{ state: 'running' }`.
- `continue` / `stepOver` / `stepInto` / `stepOut` / `pause` each record their name.
- `armStopWaiter()` records `arm` and hands out the next scripted promise; it throws if none is scripted.
- `getCurrentDebugState()` returns a state with `sessionActive` true, `fileName` `main.c`, `fileFullPath` `/w/main.c`, `currentLine` 42 and `frameName` `main`.
- `readCoreRegisters()` returns `{ pc: '0x08000100', lr: '0x08000200' }`.

The handler is built with that fake, an empty config manager and `timeoutInSeconds` 5.

- **T1.** Given `reached init`, when translated, then format `reached init\n` and no arguments.
- **T2.** Given `count={count}`, then format `count=%d\n` and arguments `['count']`.
- **T3.** Given `name={name:%s} duty={duty:%f}`, then format `name=%s duty=%f\n` and `['name', 'duty']`.
- **T4.** Given `t={ticks:%08lx}`, then format `t=%08lx\n` and `['ticks']`.
- **T5.** Given `v={ns::value}`, then format `v=%d\n` and `['ns::value']`: a scope operator is not a specifier.
- **T6.** Given `{{literal}} x={x}`, then format `{literal} x=%d\n` and `['x']`.
- **T7.** Given `duty 50% at {t}`, then format `duty 50%% at %d\n` and `['t']`.
- **T8.** Given the message `path "C:` + one backslash + `dev"`, then the format escapes each quote as backslash-quote and the backslash as two backslashes, followed by `\n`.
- **T9.** Given `{buf[i]} {p->field} {a + b}`, then arguments `['buf[i]', 'p->field', 'a + b']`.
- **T10.** Given `x={unclosed`, then it throws matching `Unbalanced '{'`; given `x=}`, then it throws matching `Unbalanced '}'`.
- **T11.** Given `x={}`, then it throws matching `Empty interpolation`.
- **T12.** `formatBreakpointModifiers({ enabled: true })` is empty. T12–T16 pin `src/debugState.ts`, which `list_breakpoints` uses; keep them here or move them to a debugState test.
- **T13.** With condition `i == 100`, the suffix is a space plus `[when: i == 100]`.
- **T14.** With logMessage `x={x}`, the suffix is a space plus `[log: x={x}]`.
- **T15.** With `enabled: false`, condition `n > 0`, logMessage `n={n}` and hitCondition `>5`, the suffix is a space plus `[when: n > 0, log: n={n}, hits: >5, disabled]`.
- **T16.** `formatBreakpointModifiers({})` is empty: an absent `enabled` is not "disabled".
- **T17.** Given a waiter that resolves `stopped` with reason `breakpoint`, when `handleContinue()`, then the calls are exactly `['arm', 'continue']`, the result starts with `Target stopped (reason: breakpoint).`, and it contains `main.c` and `42`.
- **T18–T20.** Given a `stopped` waiter with reason `step`, when `handleStepOver()` / `handleStepInto()` / `handleStepOut()`, then the calls are `['arm', 'stepOver' | 'stepInto' | 'stepOut']` and the result contains `reason: step`.
- **T21.** Given a waiter that never settles, when `handleContinue()`, then it has not settled after 100 ms: only a stop event ends the wait, never a cleared stack item.
- **T22.** Given waiters `timeout` and then `stopped` (`pause`), when `handleContinue()`, then:
  - the calls are `['arm', 'continue', 'arm', 'pause']`;
  - the result contains `'continue_execution' did not complete within 5s` and `Recovery attempt`;
  - the result contains `Paused successfully. PC = 0x08000100, LR = 0x08000200 in main at main.c:42.`
- **T23.** Given an `ended` waiter, when `handleContinue()`, then the result contains `Debug session ended during 'continue_execution'`.
- **T24.** Given status `running` and a `stopped` waiter, when `handlePause()`, then the calls are `['arm', 'pause']` and the result starts with `Target paused.`.
- **T25.** For budgets 1 000, 4 000, 8 000, 16 000 and 60 000:
  - `firstDelayMs + probeMs + secondDelayMs + probeMs` ≤ budget;
  - 250 ≤ `probeMs` ≤ 5 000, `firstDelayMs` > 0 and `secondDelayMs` ≥ 0;
  - `probeSchedule(8000)` is `{ firstDelayMs: 2800, secondDelayMs: 1200, probeMs: 2000 }`, and `probeSchedule(0)` equals `probeSchedule(1000)`.

### Pinned by the transport tests

`npm run test:surface` compares every tool's reply with no session against `test/transport/surface.snapshot.json`, in five server shapes. The shapes cover the single-window default, all tool groups, and routed through a worker (where the router wraps thrown errors). The `default` shape expects the following; `[REWORD]` marks entries whose snapshot text changes with the rewording and must be updated in the rewrite commit.

- **T26.** `start_debugging` (`fileFullPath` `/nonexistent/main.c`, `workingDirectory` `/nonexistent`): isError `Error starting debug session: TypeError: vscode.Uri.joinPath is not a function`.
- **T27.** `stop_debugging`: `SP1` [REWORD].
- **T28.** `step_over`, `step_into`, `step_out`, `continue_execution`: isError `⟨M11–M14⟩: Error: ⟨G1⟩`, where `G1` has the operation, state `no-session` and `G2`. Only the [REWORD] prefix changes.
- **T29.** `pause_execution`: isError `P1`.
- **T30.** `wait_for_stop`: `Error in 'wait_for_stop': ⟨W1⟩`, not isError.
- **T31.** `restart_debugging`: isError `⟨RS4⟩: Error: ⟨RS1⟩`, both [REWORD].
- **T32.** `reset`: `Error in 'reset': ⟨RE1⟩`, not isError.
- **T33.** `add_breakpoint` (`lineContent` `int main(void)`): isError `Error adding breakpoint: Error: not stubbed`.
- **T34.** `remove_breakpoint` (`/nonexistent/main.c`, line 1): `RM1` [REWORD]. `clear_all_breakpoints`: `CL1` [REWORD]. `list_breakpoints`: `LB1` [REWORD].
- **T35.** The fenced, gated tools `list_variable_names`, `get_variables_values`, `evaluate_expression`, `read_memory`, `read_core_registers`, `read_cycle_counter`, `read_peripheral_register`, `get_fault_info`, `diagnose_fault`, `get_call_stack` and `get_threads` each return `Error in '⟨tool⟩': ⟨G1⟩` with their operation, not isError. The gate must run before argument handling, for example `variableNames: ['x']` and `address: '0x20000000'`.
- **T36.** `lookup_peripheral` (`name` `SCB`): `SVD1` with `Tried:` and the single entry `- workspace *.svd (none)`, indented two spaces.
- **T37.** `get_device_info`: isError `Error getting device info: Error: No active debug session. Start debugging first.`
- **T38.** `check_target_connection`: `No active debug session.` (executor pass-through).
- **T39.** `cmsis_action` (`stop_run`, no CMSIS extension): `CA2` with description `none` and `serverVersion=2.3.10`.
- **T40.** `flash` (`cbuildRunFile` `/nonexistent/x.cbuild-run.yml`): `FL2` with that path.
- **T41.** `get_session_status`: `SS1` `no-session`, `DAP responsive: false`, `SS7` with 0 live sessions and `undefined`, then `SS8`.

`npm run test:transport` (`session-lifecycle.js`), with a stubbed CMSIS Solution extension and a csolution declaring `HE` (unnamed set) and `HP` (sets `debug`, `release`):

- **T42.** Given active target `HE`, when `cmsis_action { action: 'detach' }`, then `CMSIS 'detach' on HE issued via 'cmsis-csolution.cmsisDetachDebugger'. …` (`CA17`).
- **T43.** When the target is `Nope`, then `CA15` with `TS4` naming `'Nope' is not declared` and `Declared targets: HE, HP@debug, HP@release`, no command executed and no `cmsis.json` written.
- **T44.** When the target is `HP@release`, then `cmsis.json` gets `targetSet.demo.activeTargetType` `HP` and `HP` 1, the commands run are deactivate then activate with the solution path, and the result reads `CMSIS 'detach' on HP@release, switched from HE issued …`.
- **T45.** When the target is `HP` and `HP@release` is active, then no switch happens and the result reads `on HP@release issued`.
- **T46.** Given an extension that ignores the written selection, when the target is `HP` with `timeoutMs` 20 000, then `CA15` with `TS7`: `wrote 'HP' to …cmsis.json … still reports 'HE' … Manage Solution …`.
- **T47.** `lookup_peripheral {}` without an SVD is not isError and matches `No SVD file found.*Tried:`. Three consecutive `get_threads` calls all return.

### Characterization cases to add

These cases use a fake executor like the one above, extended per case. Where a case needs VS Code task events or `vscode.debug.activeStackItem`, the implementation should let the test inject them.

- **T48.** Given a fenced body that throws `Error('x')` under label `read_memory`, then the method resolves `Error in 'read_memory': x`.
- **T49.** Given `timeoutMs` 100 and a body that never settles, then the method resolves `F1` with `within 100 ms`; a late body result is ignored.
- **T50.** Given no `timeoutMs`, or 0, then the fence limit is 30 000 ms. Given `timeoutMs` 120 000, then it is 60 000 ms (use a fake clock).
- **T51.** Given `hasActiveSession()` false and each of the five states, when any gated method runs, then it fails with `G1` and the hint `G2`–`G6` for that state.
- **T52.** Given `hasDebugSession()` true, when `handleStartDebugging`, then it returns `ST1` with the session name (or `?`) and state, and neither `promptForConfiguration` nor any start call happens.
- **T53.** Given no `configurationName`, when `handleStartDebugging`, then `promptForConfiguration(workingDirectory)` is called first. If it rejects, the method throws `Error starting debug session: ⟨String(error)⟩`, plus `D1` when diagnostics exist.
- **T54.** Given `configurationName` `CMSIS Debugger: pyOCD` and `startDebuggingByName` true with status `stopped`, then it returns `ST2` with that name and the full-state JSON. A following motion call then includes the breakpoint list only if it changed.
- **T55.** Given configuration `Default Configuration` and no `fileFullPath`, then it throws `ST10` wrapping `ST8`.
- **T56.** Given the file path and `testName` `t1`, then `getDebugConfig(wd, file, undefined, 't1')` and `startDebugging(wd, config)` are called, and the result contains `ST5` and the test fragment.
- **T57.** Given no session, `stop_debugging` returns `SP1`. Given a session, it calls `stopDebugging()` once and returns `SP2`, a blank line and `SP3`.
- **T58.** `wait_for_stop` budgets: `timeoutMs` 5 000 calls `waitForStop(3500)`, 1 000 calls it with 100, and none with 28 500. Kinds: `timeout` gives `W2`; `ended` gives `W3`; `already-stopped` with a null reason gives `Target was already stopped (reason: unknown).`; `stopped` with reason `breakpoint` and threadId 3 gives `Target stopped (reason: breakpoint, threadId=3).`.
- **T59.** Pause states:
  - `stopped` with detail `breakpoint` gives `P2`; `unresponsive` gives `P3`; `initializing` gives `P5`.
  - `no-session` while `hasDebugSession()` is true throws `P4`; `hasDebugSession()` false throws `P1`.
  - Running with a `timeout` waiter gives `P6`; with an `ended` waiter, `P7`.
- **T60.** Motion recovery variants:
  - `readCoreRegisters` throws `boom`: `PC = <read failed: boom>` without an LR part.
  - Recovery waiter `timeout`: `M6`. `ended`: `M5`.
  - `pause` throws: `M10`.
  - The state has `currentLineContent`: an `M8` line.
- **T61.** Given `timeoutInSeconds` 180 and `timeoutMs` 5 000 on `continue_execution` with a `timeout` waiter, then `armStopWaiter(5000)` is called and the text says `within 180s` (known bug KB8). Without `timeoutMs`, `armStopWaiter(60000)`.
- **T62.** Given a request that throws after arming, when `handleStepOver`, then it throws `M11` + `: ⟨String(error)⟩`.
- **T63.** `restart_debugging` without a session throws `⟨RS4⟩: Error: ⟨RS1⟩`. With `restart()` resolving and status `running`, it returns `RS3`.
- **T64.** Given `reset {}`, then `resetTarget({ method: 'auto', halt: undefined, timeoutMs: undefined })` and the result is `renderResetOutcome(outcome, undefined)`.
- **T65.** `add_breakpoint` with `line` 0 throws `Error adding breakpoint: Error: Invalid line number 0: must be a 1-based integer.`. With neither `line` nor `lineContent` it throws `BP13` wrapping `BP2`.
- **T66.** Given no session, `add_breakpoint` at line 10 with condition `i > 3` calls `addBreakpoint(uri, 10, { condition: 'i > 3' })` and returns `BP4` with the suffix `[when: i > 3]` (after a space), then `BP8`.
- **T67.** With a session, the GDB reply decides the result:
  - `Breakpoint 2 at 0x800012c: file main.c, line 10.` gives `BP11` with `line 10: Breakpoint 2 at … [bound]`.
  - `No source file named foo.c.` gives `BP10` with `[rejected]`.
  - `Error: could not evaluate expression` gives `BP12` with `line 10: <no echo from adapter — normal> [unconfirmed]`.
  - A mix of `bound` and `rejected` gives `BP10`.
- **T68.** Given a document whose lines 3, 7 and 9 contain `return;`, when `lineContent` is `return;`, then there are three model adds and three GDB sets in order, and the head is `Breakpoints added at 3 locations in ⟨path⟩: lines 3, 7, 9` followed by `BP7` with `3 line(s) matched`.
- **T69.** `add_logpoint` without a session calls `addBreakpoint(uri, line, { condition, logMessage })` and returns `LP1` + `LP2`.
- **T70.** With a session, reply `Dprintf 3 at 0x8000100` and condition `n > 5`: `setBreakpointConditionViaGdb(3, 'n > 5')` is called, and the lines are `LP1`, `LP3`, `LP6`, an empty line and then `LP8`'s text.
- **T71.** A logpoint condition with a reply that has no number gives `LP7`. A `rejected` reply gives `LP1`, `LP3`, `LP4` and `LP5` only, with no condition call.
- **T72.** `remove_breakpoint` with no matching model breakpoint returns `RM1` and makes no GDB call. With a match and a session whose reply is empty, it returns `RM2` + `RM4`; with reply `Deleted breakpoint 1`, `RM2` + `RM3`.
- **T73.** `clear_all_breakpoints`:
  - No breakpoints and no session: `CL1`.
  - Two breakpoints and no session: `Cleared 2 breakpoint(s) from the model.`
  - Zero breakpoints with a session and an empty reply: `Cleared 0 breakpoint(s) from the model.` + `CL4`.
- **T74.** `list_breakpoints`:
  - A source breakpoint at `/w/src/main.c` line index 41 with condition `x` renders `1. main.c:42 [when: x]\n`.
  - A function breakpoint `HardFault_Handler` renders `2. Function: HardFault_Handler\n`.
  - A third kind is skipped but keeps its index.
- **T75.** `get_variables_values` with scope `global`: the first `getVariables(frameId, 'global', t)` returns no scopes and the second `(frameId, 'all', t)` returns some, so the result starts with `V3`. With names that match nothing, `V4`.
- **T76.** `evaluate_expression`:
  - With redaction on, `apiKey` is passed through `redactExpressionResult`; `-exec info registers` is returned verbatim via `String(result)`.
  - `type` `int` appends `E3`. A redacted value appends a blank line and `REDACTION_NOTICE`.
  - A result of `undefined` gives `Error in 'evaluate_expression': ⟨E4⟩`.
- **T77.** `read_memory` of 20 bytes at `20000000`, format `both`: the header is `Memory at 0x20000000 (20 bytes):`, there are two hex rows, `0x20000000: …` (16 bytes) and `0x20000010: …` (4 bytes), each indented two spaces, then the ASCII block. If the executor returns fewer bytes, the header still says 20.
- **T78.** `read_core_registers` normalisation and layout:
  - `536870912` becomes `0x20000000`, `0x8000123 <main+4>` becomes `0x8000123`, and `0X1F <x>` is unchanged.
  - A missing `r5` is `<?>`. `xpsr` `[ Z C ]` is printed raw.
  - Every row is two spaces plus four cells: name padded to 4, `=` and a space, value padded to 14. The last line is the `primask` line (`REG8`).
- **T79.** `read_cycle_counter`: not present gives `CYC1`. Present with 255 cycles and `enabledNow` gives `DWT cycle counter: 255 (0x000000ff)` followed by `CYC3`–`CYC6`.
- **T80.** `diagnose_fault` degradation:
  - `readCoreRegisters` throws: the skipped list is `['core registers']`, LR is undefined so the frame note is `DF1`, and the frame read is not attempted.
  - `getCallStack` throws: `call stack` is skipped.
  - `loadSvdForLookup` returns no device: `DF5`.
  - The call stack is requested as `getCallStack(undefined, 3, t)`, or with `levels` when given.
- **T81.** `lookup_peripheral` with `svdFile` `src/test/fixtures/test-device.svd`:
  - An address takes precedence over a name. `zz` gives `SVD2`.
  - An unknown name gives `SVD3` (with suggestions when close). No name and no address gives the peripheral list.
  - `lookup_register` with an unknown register gives `SVD4`.
- **T82.** `get_call_stack`:
  - 25 frames and no `levels`: 20 frame lines, then `CS4` with 5 hidden frames. With `levels` given, all frames.
  - One frame: `Call stack (1 frame):`. A frame without source: `<no source>:?`. The frame id is shown as `[frameId=⟨id⟩]` after a space.
  - `getCallStack(threadId, 50, t)` when `levels` is absent.
- **T83.** `get_threads` with 40 threads: 32 thread lines, then `TH4` with 8 hidden threads. A thread with a top frame gets two spaces and `→ ⟨name⟩ @ ⟨source⟩:⟨line⟩` after its name.
- **T84.** `get_frame_variables` with no scopes returns `FV1`. Names that match nothing give `FV2`. Otherwise the header is `Variables for frameId=⟨id⟩`.
- **T85.** `check_target_connection`: when the executor throws a `HardwareTimeoutError`, it returns `check_target_connection: ⟨message⟩`; any other error throws `TC2`.
- **T86.** `get_session_status`:
  - Each state gives its hint. `no-session` gives `SS8` with 0 live sessions and `SS9` otherwise.
  - The optional lines appear only when their fields are truthy.
  - `dapProbeMs` 12 gives `DAP responsive: true (probe 12ms)`. Live session names appear in brackets.
- **T87.** `get_device_info` with active target `HP@debug` returns the trimmed info + `\n  CMSIS target: HP@debug`. When the target query fails, the info is returned unchanged.
- **T88.** `cmsis_action`:
  - `load_and_debug` with a session returns `CA1` and executes no command.
  - Target `@x` gives `CA3`.
  - Target `HP` while `HE` is active and a session exists gives `CA4` for `detach`.
- **T89.** `cmsis_action detach` whose command rejects with `Error: no active solution` within 4 s gives `Error in 'cmsis_action': ⟨CA5⟩`. Any other rejection gives `CA6` + `D1`. A rejection after 4 s is ignored.
- **T90.** `cmsis_action build` with injected task events:
  - A process start and end for name `cbuild …` with type `cmsis-csolution.build` and exit 0 give `CA7` + `CA7a`. Exit 2 gives `CA8`. An undefined exit code gives `CA9`.
  - Name `CMSIS Load`, source `Workspace`, type `shell` never matches, so the result is `CA10` after the budget (known bug KB5).
  - A match that starts but never ends gives `CA11` with the waited seconds.
  - A matching end from an unrelated earlier execution settles the call (known bug KB5).
- **T91.** `cmsis_action attach`:
  - The session never becomes `running` / `stopped` within 8 s: `CA14`.
  - It becomes live and `getThreads` returns 1 thread at both probes: `CA12` with `t+3s: 1 thread(s), t+6s: 1 thread(s) — target threads present`.
  - 0 threads at the second probe: `CA13` with `…, then t+6s: session object present but 0 threads — adapter is not connected to a target`.
- **T92.** `flash`:
  - With a session: `FL1`.
  - A relative `cbuildRunFile` resolves against the first workspace folder, and a missing file gives `FL2` with the resolved path.
  - No workspace folder and no argument: `FL3`.
  - Two `out/**` matches: `FL4` listing both.

## Constraints

- **Header.** The new `src/debuggingHandler.ts`, any new module split out of it, and the rewritten `src/test/debuggingHandler.test.ts` start with the Arm Apache-2.0 block exactly as in `src/core/toolRun.ts` lines 1–15. No Microsoft line. Remove `src/debuggingHandler.ts` and `src/test/debuggingHandler.test.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- **Clean room.** Do not read the old file, its git history, `out/`, `dist/`, an installed VSIX, the DebugMCP repository, or `docs/architecture/debuggingHandler.md` (DebugMCP-derived). Everything Arm-authored in the repository may be read.
- **Provenance gate.** `npm run provenance:check -- --gate` (`scripts/provenance-check.ts`) is the authority. In its current form it fails a file without the Microsoft line when more than 5 of its distinct trimmed, non-trivial lines occur anywhere in DebugMCP's history. Non-trivial means at least 20 characters, with imports and short field declarations excluded.
  - It gates `src/debuggingHandler.ts` and every file created since `951530e`, so modules split out of the handler count too.
  - Lines that collide easily if written in the conventional form: the declaration lines of `IDebuggingHandler` and `DebuggingHandler`; the one-line interface members for `handleStopDebugging`, `handleAddLogpoint`, `handleRemoveBreakpoint`, `handleClearAllBreakpoints` and `handleListBreakpoints`; constructor parameter-property lines named `executor` / `configManager` / `timeoutInSeconds`; destructuring `args` into the argument names; building a URI from `fileFullPath` in a local named `uri`; opening a text document from that URI; the classic error-wrapper lines.
  - The contract fixes member names, parameter types and return types, not the declaration form. Named argument types, multi-line signatures and different local names are all fine, provided `IDebuggingHandler` stays assignable from and to the router's implementation.
  - All exports must remain importable from `src/debuggingHandler.ts` (re-exports allowed): `opTable.ts` uses `import type`, and the router and control server import the module path.
- **Logging.** Use `logger` from `src/utils/logger.ts` (`info`, `warn`, `error`), never `console.*`. Log events: the session became active (state), each session-wait attempt (attempt number, state), and a stop-waiter timeout (limit in ms). The log wording is free.
- **Runtime surface.**
  - Reach VS Code only through the APIs listed under the dependencies.
  - Touch `vscode.tasks` only for the four build-class `cmsis_action` actions, because the transport stub has no `vscode.tasks`.
  - Read `lineContent` files and `launch.json` through `vscode.workspace.openTextDocument`.
  - Everything the executor can do goes through `IDebuggingExecutor`. On the motion path use only the executor methods listed there, so the unit-test fake keeps working.
- **Timers.** Clear the fence timer and the task-waiter timer once they have settled. No timer may keep a finished call alive beyond the waits described.
- **Style.** Follow AGENTS.md: strict TypeScript, explicit types, no `any` where avoidable, semicolons, braces for every block, imports ordered vscode → external → internal, and `import * as vscode from 'vscode'`. Match the tree's 4-space indentation.
- **Checks.** `npm run compile`, `npm run lint`, `npm test`, `npm run test:transport` and `npm run test:surface` must pass. The snapshot may change only in the `[REWORD]` texts listed in T27, T28, T31 and T34, in every shape where they appear; list those changes in the commit message. For the DAP path, run `test/realboard/run.ts` on a probe board as well.
