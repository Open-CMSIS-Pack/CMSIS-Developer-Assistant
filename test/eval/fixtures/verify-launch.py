#!/usr/bin/env python3
"""Replay cdt-gdb-adapter's launch path against the project's launch.json.

Run from the workspace folder:

    python3 .claude/skills/fvp-debug-setup/templates/verify-launch.py \
        [--config "Arm-FVP@GDB (launch)"] [--gdb arm-none-eabi-gdb]

This is the only verification that proves the setup works, because it exercises
the readiness handshake -- starting the model and attaching GDB by hand skips
exactly the part that breaks (see SKILL.md section 5).
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

left = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                      capture_output=True, text=True).stdout.split()
print("containers left after teardown:", left or "none")
sys.exit(0 if "Temporary breakpoint" in r.stdout and not left else 1)
