#!/usr/bin/env python3
"""Replay cdt-gdb-adapter's launch path against the project's launch.json.

Run from the built workspace folder, using this helper in the repository:

    python3 /path/to/CMSIS-Developer-Assistant/test/eval/fixtures/verify-launch.py \
        [--config "Arm-FVP@GDB (launch)"] [--gdb arm-none-eabi-gdb]

This checks the adapter's readiness handshake, which a manual model start and
GDB attachment do not exercise. For the setup procedure, use knowledge_get
with id "proc-fvp-debug-setup".
"""
import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time

ap = argparse.ArgumentParser()
ap.add_argument("--launch-json", default=".vscode/launch.json")
ap.add_argument("--config", default="Arm-FVP@GDB (launch)")
ap.add_argument("--gdb", default="arm-none-eabi-gdb")
args = ap.parse_args()

# launch.json is JSONC; strip whole-line // comments, which is all VS Code's own
# generated files and our annotations use.
raw = re.sub(r"^\s*//.*$", "", open(args.launch_json).read(), flags=re.M)
configs = json.loads(raw)["configurations"]
try:
    cfg = next(c for c in configs if c["name"] == args.config)
except StopIteration:
    sys.exit(f"no launch config named {args.config!r} in {args.launch_json}")

target = cfg["target"]


def expand(s):
    s = s.replace("${workspaceFolder}", os.getcwd())
    return re.sub(
        r"\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: os.environ.get(m.group(1), ""), s
    )


server = expand(target["server"])
params = [expand(p) for p in target.get("serverParameters", [])]
print("spawn:", server, " ".join(params))

proc = subprocess.Popen(
    [server] + params, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
)

# The adapter's own readiness rule: with target.port blank it accumulates the
# server's output and waits for serverPortRegExp; with a port set it would wait
# target.serverStartupDelay (default 0ms) instead -- which is the bug.
regexp = target.get("serverPortRegExp")
timeout = target.get("portDetectionTimeout", 10000) / 1000.0
port, acc, t0 = target.get("port") or None, "", time.time()
if port and params:
    delay = target.get("serverStartupDelay", 0) / 1000.0
    print(f"!! target.port is set -> adapter would connect after {delay}s with no readiness check")
    time.sleep(delay)
elif regexp:
    rx = re.compile(regexp)
    for line in proc.stdout:
        sys.stdout.write("  server| " + line)
        acc += line
        m = rx.search(acc)
        if m:
            port = m.group(1)
            break
        if time.time() - t0 > timeout:
            proc.terminate()
            sys.exit(f"serverPortRegExp never matched within {timeout}s")
    print(f"port detected: {port} after {time.time() - t0:.1f}s")
else:
    proc.terminate()
    sys.exit("config has neither a usable port nor serverPortRegExp")

# Keep draining, so the model never blocks on a full pipe and late output shows.
threading.Thread(
    target=lambda: [sys.stdout.write("  server| " + l) for l in proc.stdout], daemon=True
).start()

cmds = ["-ex", "file " + cfg["program"], "-ex", f"target remote localhost:{port}"]
for ic in cfg.get("initCommands", []):
    if ic.strip():
        cmds += ["-ex", ic]
cmds += ["-ex", "continue", "-ex", "bt", "-ex", "detach"]
r = subprocess.run([cfg.get("gdb", args.gdb), "-q", "-batch"] + cmds,
                   capture_output=True, text=True, timeout=300)
print("--- gdb ---")
print((r.stdout + r.stderr).strip())

proc.terminate()
try:
    proc.wait(timeout=30)
except subprocess.TimeoutExpired:
    proc.kill()

left = []
fixture_shim = os.path.join(os.getcwd(), ".vscode", "fvp.sh")
if sys.platform == "darwin" and os.path.realpath(server) == os.path.realpath(fixture_shim):
    # The fixture shim labels its Docker container with the shell's PWD. Bash
    # preserves a logical PWD only when it names the actual working directory.
    workspace = os.environ.get("PWD", os.getcwd())
    try:
        if not os.path.samefile(workspace, os.getcwd()):
            workspace = os.getcwd()
    except OSError:
        workspace = os.getcwd()
    left = subprocess.run(
        ["docker", "ps", "--filter", f"label=cmsis.fvp.folder={workspace}", "--format", "{{.Names}}"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    print("fixture containers left after teardown:", left or "none")
sys.exit(0 if "Temporary breakpoint" in r.stdout and not left else 1)
