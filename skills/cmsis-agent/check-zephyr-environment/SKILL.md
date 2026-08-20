---
name: check-zephyr-environment
description: Verify an existing Zephyr workspace, its Python virtual environment, and the venv-local west installation. Use before running Zephyr commands or creating projects that depend on an installed Zephyr workspace.
---

# Check Zephyr Environment

## Target & Persona

- **Role:** Verification Engineer
- **Objective:** Establish whether an existing Zephyr workspace can be used through its own virtual environment and venv-local west executable.

## Prerequisites & Context

- **Expected input:** A Zephyr workspace path, or permission to use the default location named below.
- **Dependencies:** An existing Zephyr workspace, its `.venv` virtual environment, Python, and a west executable installed inside that virtual environment.
- **Portability:** Supports Windows, macOS, and Linux using the platform-specific virtual-environment executable paths below. It has no MCU-, board-, toolchain-, or debugger-specific assumptions.

Obtain the Zephyr workspace path. Use `$HOME/zephyrproject` when the user followed
the default CMSIS-Zephyr installation instructions and did not choose another
location.

## Execution Steps (Strict Workflow)

1. **Analysis:** Identify the workspace and host operating system, then select the platform-specific virtual-environment executables.
2. **Processing:** Run the detailed checks below using only the venv-local Python and west executables.
3. **Validation:** Confirm virtual-environment isolation, west operation, workspace identity, and the installed Zephyr repository path.
4. **Formatting:** Return the defined `PASS` or `FAIL` report and the corrective reference for a failed check.

### Detailed procedure

1. Determine the host operating system. Confirm that the workspace and its
   `.venv` directory exist.
2. Select the virtual-environment executables for the host:
   - Windows: `.venv/Scripts/python.exe` and `.venv/Scripts/west.exe`
   - macOS/Linux: `.venv/bin/python` and `.venv/bin/west`
3. Confirm that both executables exist.
4. Run the selected Python executable with
   `-c "import sys; print(sys.prefix); print(sys.base_prefix)"`. Confirm that
   `sys.prefix` differs from `sys.base_prefix`.
5. Run the selected `west` executable with `--version`. Do not substitute a
   global `west` executable.
6. From the Zephyr workspace, run the selected `west` executable with `topdir`.
   Confirm that it succeeds and resolves to the expected workspace.
7. From the same directory, run the selected `west` executable with
   `list zephyr -f "{abspath}"`. Confirm that it returns an existing Zephyr
   repository path.

Stop on the first failed check. Do not install, upgrade, repair, or reconfigure
Zephyr, Python, or west.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent workspace paths, executable paths, Zephyr repository locations, or command results.
- **Portability:** Use only the documented platform-specific venv paths; do not introduce board, MCU, toolchain, or debugger assumptions.
- **Critical blockers:** Stop at the first missing workspace, virtual environment, executable, failed command, or mismatched west top-level directory.
- **Scope:** Verify the existing Zephyr environment only; do not install, update, repair, or reconfigure Zephyr, Python, or west.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Report:

- status: `PASS` or `FAIL`;
- workspace path;
- virtual-environment path;
- selected Python and west executable paths;
- west version;
- Zephyr repository path;
- failed check and corrective reference when status is `FAIL`.

Return `PASS` only when every check succeeds.

## Validation Resources

- [CMSIS-Zephyr setup](https://github.com/Arm-Examples/CMSIS-Zephyr)
