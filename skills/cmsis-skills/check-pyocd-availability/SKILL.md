---
name: check-pyocd-availability
description: Prefer the active Visual Studio Code CMSIS Debugger extension's bundled pyOCD, or otherwise check whether pyOCD is runnable from the active shell. Use before a workflow needs to run pyOCD without installing, configuring, or modifying it.
---

# Check pyOCD Availability

## Target & Persona

- **Role:** Tool Integrator and Verification Engineer
- **Objective:** Return a verified, actionable pyOCD availability result for the active shell or Visual Studio Code environment.

## Prerequisites & Context

- **Expected input:** The active host environment; an open Visual Studio Code workspace or its integrated terminal when Visual Studio Code is in use.
- **Dependencies:** In Visual Studio Code, the `code` command or the Extensions view is needed to identify the active `arm.vscode-cmsis-debugger` installation. A runnable `pyocd` command is needed only for the PATH fallback.
- **Portability:** Support Windows, macOS, and Linux. Do not assume a device, probe, target, Python installation, or a default Visual Studio Code extensions directory.

## Execution Steps (Strict Workflow)

1. **Analysis:** Determine whether the work is in a Visual Studio Code environment. When it is, identify the active CMSIS Debugger extension installation for that VS Code context. Check the exact identifier `arm.vscode-cmsis-debugger` using `code --list-extensions --show-versions` or the Extensions view.
2. **Processing:** In Visual Studio Code, locate the active extension's actual installation directory and verify `<extension-installation>/tools/pyocd/` exists. Account for an extension-specific, portable, remote, or profile-specific extensions location; do not assume the platform default. When verified, report this bundled directory as the preferred pyOCD installation and stop: it is not necessary to check `PATH`.
3. **Fallback:** When Visual Studio Code does not provide a verified bundled pyOCD directory, open or use its integrated terminal and resolve `pyocd` using the host command lookup, then run `pyocd --version`. Do not substitute an external shell, because extension-contributed tools are normally added to the integrated terminal's `PATH`. Outside Visual Studio Code, perform the same PATH check in the active shell.
4. **Validation:** Confirm the result in the environment used for the lookup: a bundled result requires the exact extension ID and its `tools/pyocd/` directory; a PATH result requires a successful `pyocd --version`; otherwise report pyOCD unavailable. Do not proceed to target detection or install software.
5. **Formatting:** Return the result using this form; do not create a workspace artifact.

   ```text
   Environment: <VS Code | VS Code integrated terminal | host shell>
   CMSIS Debugger extension: <active installed version and directory | not applicable | unavailable>
   Bundled pyOCD directory: <verified path | unavailable | not applicable>
   pyOCD on PATH: <not checked because bundle is preferred | resolved command and version | unavailable>
   Status: <bundled directory available | available on PATH | unavailable>
   ```

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not infer an executable path, extension location, version, or availability from the extension identifier alone.
- **No mutation:** Do not install pyOCD or an extension, change `PATH`, activate an environment, or alter Visual Studio Code settings.
- **VS Code scope:** Check the active extension before PATH in a Visual Studio Code environment. Prefer a verified bundled directory and do not perform a redundant PATH check. A bundled directory does not establish that `pyocd` is runnable from the current `PATH`.
- **Critical blockers:** Report the relevant check as unavailable when the required terminal, extension query, or extension directory cannot be accessed. Do not search unrelated directories or request a target connection.
- **Scope:** Check availability only. Use `$pyocd-detect-debug-topology` for an authorized target scan after pyOCD availability is established.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Return one availability record in the stated format, preferring a verified bundled directory in Visual Studio Code, otherwise a runnable PATH command, or an explicit unavailable result. Identify the environment in which the result was obtained.

## Validation Resources

Use `pyocd --version` as the repeatable runnable-command check. In Visual Studio Code, use the exact installed-extension identifier `arm.vscode-cmsis-debugger` and verify its actual `tools/pyocd/` subdirectory. Visual Studio Code documents `code --list-extensions` and `--show-versions` for installed-extension checks.
