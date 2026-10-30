# Troubleshooting Python debug sessions

Notes for Python programs run under the Python Debugger extension (debugpy) and driven with this server's tools. Find the cause by stopping the program and reading its state instead of adding temporary `print()` calls: one stop shows every local at once and needs no edit.

## Starting the session

- Set the first breakpoints with `add_breakpoint` before `start_debugging`. The program does not stop on entry, so a short script can finish before a breakpoint added later could ever matter.
- With an entry in `.vscode/launch.json`, pass its name as `configurationName`. `workingDirectory` picks the workspace folder whose `launch.json` is read, and the entry runs exactly as written.
- `configurationName: "Default Configuration"` builds the launch from the file instead: `fileFullPath` runs as a script without arguments, in the file's own folder (not in `workingDirectory`), with its output in the integrated terminal. Leaving `configurationName` out opens a picker for the user, and the call waits for their choice.
- No tool returns what the program prints, whether it lands in the terminal or in the Debug Console. Work out what happened from the state at a stop.
- After `start_debugging` the program is running: `wait_for_stop` waits for the first breakpoint, while `continue_execution` refuses until the program has stopped.
- Settings that decide whether your breakpoints can be reached belong in a `launch.json` entry (type `debugpy`, or the older `python`):
  - `program` runs a script path; `module` runs `python -m pkg.cli`. Code with package-relative imports needs `module` and a `cwd` above the package.
  - `args`, `cwd`, `env` and `envFile`: a missing argument, file or variable often ends the run before the interesting code.
  - `python`: the interpreter, such as the project's `.venv/bin/python`; without it the interpreter selected in VS Code runs.
  - `justMyCode` (on unless configured otherwise), `subProcess` (on: Python child processes are debugged as well) and `stopOnEntry`.

## One test at a time with testName

`testName` only shapes the configuration `start_debugging` builds itself (`configurationName: "Default Configuration"`); a named entry runs as written and ignores it. The built configuration runs `python -m unittest <module>.<Class>.<test> -v` in the test file's folder, with `justMyCode` off:

- `<module>` is the file name without `.py`. A `testName` containing a dot is appended as given (`TestParser.test_empty`). Without a dot, `<Class>` is the first capitalised name after the word `class` anywhere in the file, comments and strings included, so pass `Class.test_name` whenever the file holds more than one class.
- It is unittest only. For pytest, add an entry with `"module": "pytest"` and `"args": ["tests/test_parser.py::test_empty"]` and pass its name.
- The project root is not on `sys.path` when the test file sits in a subfolder, so a package there that is not installed fails to import. Use an entry whose `cwd` is the project root.
- A failing assertion is caught by the test runner and never counts as uncaught, so the run does not stop at it. Break on the assertion line, with a `condition` when it sits in a loop.

## When a breakpoint never hits

The session ends, or `wait_for_stop` runs into its timeout; a `continue_execution` whose wait runs out answers `running` and leaves the program running, and `pause_execution` shows the line it is on. Work through the likely reasons:

- **The code ran before the breakpoint existed.** Module-level code runs once, at import. Add the breakpoint and call `restart_debugging`; breakpoints survive the restart.
- **Another copy of the file runs.** A package installed into site-packages, not in editable mode, runs instead of the workspace source. `get_call_stack` shows the real paths at any stop, and evaluating `__import__('sys').modules['pkg.mod'].__file__` names the loaded file.
- **Another interpreter runs.** Evaluate `__import__('sys').executable` at a stop and set `python` in the entry if it is not the project's environment.
- **`justMyCode` filters the file.** Breakpoints in the standard library or in site-packages are ignored while it is on, and `step_into` skips such frames. Set `"justMyCode": false`.
- **The code runs in another process.** A Python child started through `multiprocessing` or `subprocess` becomes a session of its own; the tools act on the session VS Code has in focus, which `get_session_status` names. With `subProcess` off, or in a non-Python child, it cannot stop at all.
- **The code runs in an untraced thread.** Threads from `threading` are traced; a thread created by native code is not until it calls `debugpy.debug_this_thread()`.
- **The code never runs.** A coroutine nobody awaits or schedules, or a generator nobody iterates, executes no line of its body.
- **The condition fails.** A `condition` that raises counts as false, silently in the case of a misspelt name (`NameError`).
- **The line holds no code.** A breakpoint on a comment or blank line is moved to code or left unbound; put it on a statement.

## Generators, async code and threads

- Calling a generator function, or an `async def` function without awaiting it, only creates an object; the body runs later, when something iterates or awaits it. `step_into` on such a line does not enter the body: break inside the body and `continue_execution`.
- `step_over` on an `await` or a `yield` ends on the next line of the same coroutine or generator once it resumes. Other code runs in between, and a breakpoint it reaches stops the program first.
- `step_out` inside a generator or coroutine waits until its body has finished; a `yield` or an `await` does not count as leaving it. To get back to the consumer sooner, break there and continue.
- The tasks of one event loop share a thread, so `get_threads` cannot tell them apart. Stopped inside a coroutine, evaluate `__import__('asyncio').current_task()` to see which task it is.
- At a stop the other threads are held as well. `get_threads` lists them, and `get_call_stack` with a `threadId` shows where one of them is; for a hang, `pause_execution` first.

## Exceptions

- By default debugpy stops only on uncaught exceptions; "Raised Exceptions" and "User Uncaught Exceptions" are off. These switches live in VS Code's Breakpoints view and no tool sets them, so ask the user to tick one, or break on the `raise` or on the first line of the `except` block.
- An exception that a framework catches (a test runner, a web server, an `except Exception:` that logs and carries on) is never uncaught and never stops the run.
- `SystemExit` with a non-zero code, as from `sys.exit(1)` or an `argparse` error, stops like an uncaught exception; exit code 0 does not.
- Stopped on an exception, the frame's locals contain `__exception__`, a tuple of type, value and traceback: evaluate `repr(__exception__[1])`, then walk `get_call_stack` to the frame that raised.

## Reading state

- Call `list_variable_names` with `scope: "local"` first, then `get_variables_values` with the `variableNames` you need. A listing without names stops at 40 variables per scope and 200 characters per value, and module globals pass that quickly.
- `special variables`, `function variables` and `class variables` are debugpy's groups of dunder names, functions and classes, not variables of the program. After stepping over or out of a call, `(return) <function>` holds the value it returned.
- Values arrive as `repr()` text. For attributes, items or large objects use `evaluate_expression`: `order.items[0].price`, `len(rows)`, `rows[:3]`, `type(obj).__name__`.
- For another frame, take its `frameId` from `get_call_stack` and call `get_frame_variables`; `evaluate_expression` runs in the frame VS Code has in focus, normally the top frame of the stop.
- `evaluate_expression` takes Python, and Python sessions have no `-exec` passthrough. It also executes statements (`x = 0`, `import json`), and each call or property access runs program code: `next(gen)` advances the generator, `queue.get()` removes an item. The other threads stay suspended, so a call that waits for one of them (a lock, a queue, a future) hangs until the tool times out.
- A value of `None` comes back as an empty result, and `print()` inside an expression writes to the Debug Console rather than into the reply. Ask for `repr(x)` or `x is None` instead.
- Values of variables named like credentials (`password`, `token`, `api_key`) arrive as `<redacted: possible secret>`; ask for `len(token)` or `token is None`.

## Conditions and logpoints

- A `condition` is a Python expression evaluated in the frame at every hit: `i == 100`, `user is None`, `len(queue) > 10`.
- `add_logpoint` fills `{expr}` placeholders from the frame and lets the program run on, but its output goes to the Debug Console, which no tool returns. It serves a user watching that console; for values you need, stop with a conditional breakpoint and read them.

## Checklist

- [ ] Breakpoints set before `start_debugging`, on statements.
- [ ] The interpreter and the file that run are the ones you expect (`sys.executable`, paths in `get_call_stack`).
- [ ] `justMyCode` off when the cause may lie in library code.
- [ ] The session in focus is the process you mean (`get_session_status`).
- [ ] Values read with `list_variable_names`, then `get_variables_values`; expressions free of side effects unless the change is the experiment.
- [ ] The breakpoints you set removed (`remove_breakpoint`) once the cause is confirmed.
