# DebugConfigurationManager: launch configurations for `start_debugging`

`DebugConfigurationManager` (`src/utils/debugConfigurationManager.ts`)
provides the launch configuration that `start_debugging` runs when the agent
does not simply name an entry of `launch.json`. It offers the user a choice
among the folder's `launch.json` entries, and it synthesizes a configuration
from the source file's extension when asked to, or when a named entry cannot
be used.

## Scope

- A CMSIS session does not normally pass through here. `cmsis_action
  load_and_debug` and `attach` run the CMSIS Solution extension's own
  pipeline, and `start_debugging` with a `configurationName` starts that
  `launch.json` entry by name through the executor.
- This module serves the other cases: no configuration named, and general,
  non-embedded debugging, where a guess from the file type is better than
  nothing.
- It reads `launch.json` only. Target choices in `*.csolution.yml` belong to
  `src/core/cmsisTarget.ts`, which parses YAML with bounded resources and
  rejects invalid target selections before they can change the workspace.
  The generated CMSIS build files (`*.cbuild-run.yml` and friends) belong to
  `src/core/buildInfo/` and `src/core/packDocs/`.

## Key ideas

### `launch.json` as the editor sees it

`launch.json` is opened through VS Code's document model, so edits that are
not saved yet count, and parsed as JSONC with `jsonc-parser`, because
generated files carry comments and trailing commas. A missing, unreadable or
broken file reads as "no entries": `getDebugConfig()` then synthesizes a
configuration, and the picker offers only the sentinel.

### The picker and the sentinel

`promptForConfiguration(workDir, cancel?)` shows a quick-pick with one item
per `launch.json` entry (its name, or `(no name)`, with type and request)
and, always last, the sentinel `Default Configuration`, which asks for a
synthesized configuration. It resolves the chosen label; closing the picker
rejects with a message the handler passes on to the agent. The handler
compares the result with the same sentinel text.

The picker waits for a person in the window that runs the call, which the
agent may not see. The handler therefore passes a cancellation token that
fires when its limit runs out (#14). The token goes to VS Code, which closes
the picker, and the wait also races the token itself, so it ends even if
the picker stays open. A picker closed by the token rejects with
`PickerCancelled`, which carries the names of the entries it offered: the
handler turns them into the hint of its `INVALID_ARGUMENT`. That case is
logged at info level; other failures remain errors.

### Named entries and synthesized configurations

`getDebugConfig(workDir, sourceFile, launchName?, testName?)` returns the
named entry, copied and renamed `CMSIS Developer Assistant Launch (<name>)`,
when it exists. For the sentinel, an unknown name, or a missing or broken
file, it synthesizes one:

- `detectLanguageFromFilePath()` maps the file extension to a VS Code debug
  type (`python`, `node`, `java`, `coreclr`, `cppdbg`, `go`, `lldb`, `php`,
  `ruby`); an unknown extension, or none, counts as Python.
- One recipe per type builds a launch request for the file; types without a
  recipe of their own get the Python one.
- With a `testName`, a single test is run instead: Python through
  `unittest` (the test class is looked up in the file), JavaScript and
  TypeScript through Jest or Mocha depending on the file name, Java through
  JUnit's `--tests`. .NET ignores the test name; other types run the file
  and say in the configuration name that test filtering is not supported.
- Every synthesized configuration runs in the source file's own directory
  and carries a name that starts with `CMSIS Developer Assistant`, which is
  what VS Code shows as the session name.

### Safe to construct anywhere

The module does nothing at load time and its constructor calls no `vscode`
API, so the transport tests construct it under a minimal `vscode` stub.
`src/index.ts` exports it as `ConfigurationManager`, its interface as
`IConfigurationManager`.

## Where to look

- `DebugConfigurationManager`: `getDebugConfig()`, `promptForConfiguration()`,
  `detectLanguageFromFilePath()`, `getAvailableConfigurations()`,
  `hasLaunchJson()`, `validateWorkspace()`, the static
  `getAutoLaunchConfigName()`; `PickerCancelled`
- Module functions: `launchEntries()`, `pickUnlessCancelled()`,
  `plainLaunch()`, `singleTestLaunch()`, `unittestTarget()`
- Caller: `handleStartDebugging()` in `src/debuggingHandler.ts`

## Tests

- `test/transport/config-scenarios.js`: the synthesized configuration per
  file type, test configurations, named entries from plain and JSONC
  `launch.json`, and the quick-pick, compared with
  `config-scenarios.snapshot.json`
- `src/test/debugConfigurationManager.test.ts`: the quick-pick closed by its
  cancellation token, in the extension test host
