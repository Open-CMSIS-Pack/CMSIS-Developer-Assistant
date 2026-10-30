# #19 Registry file exposes the control token; agents drive the control server with curl

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** Private registry permissions and the control-channel restrictions are implemented; see [window routing](../architecture/windowRouting.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#19](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/19) |
| Area · priority · source | Multi-window/transport · Low · Studio test |
| Original release plan | 2.3.11 (WP-E; the agent-facing doc line ships with WP-D, see [50-tool-contract.md](50-tool-contract.md)) |
| Size | S |
| Depends on | none |
| Related | #12, #16, #50 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

Every window writes `controlPort` and the plaintext `controlToken` into `<tmpdir>/cmsis-developer-assistant-registry/window-<pid>.json`. Neither the directory nor the files get a mode, so they end up 0755 and 0644. The maintainer's Mac shows exactly that today, because its `TMPDIR` is a 0755 folder in the home directory, not the per-user 0700 default. On Linux the directory sits in the shared `/tmp`, so any local user can read every token and flash or erase another user's board. Any local user can also create the directory first and own it. The token compare is `!==` (not constant-time), and the control server has no Host or Origin check; the MCP endpoint has both.

The incident in the issue is a **same-user** agent reading the registry. File modes cannot stop that: a process of the same user can read anything the extension host writes. The agent-side remedies are the tool contract line (WP-D) and removing the reasons the agent went there: the 60 s cap (#12) and window selection (#16). The names in the issue (`cmsis-debugmcp-registry`, `x-cmsis-debugmcp-token`) predate the rename. The exposure is unchanged.

## Current state (2.3.10)

- The registry directory is `path.join(os.tmpdir(), 'cmsis-developer-assistant-registry')` ([workspaceRegistry.ts:43](../../src/utils/workspaceRegistry.ts#L43)). The file is `window-<pid>.json` ([:97](../../src/utils/workspaceRegistry.ts#L97)). `mkdirSync` is called without a mode in `register` and `heartbeat` ([:108](../../src/utils/workspaceRegistry.ts#L108), [:127](../../src/utils/workspaceRegistry.ts#L127)).
- `writeFileAtomicSync` and `writeFileAtomic` pass no mode ([atomicFile.ts:38-58](../../src/utils/atomicFile.ts#L38-L58)), so the umask decides: typically 0644.
- The entry holds `controlPort` and `controlToken` ([workspaceRegistry.ts:11-32](../../src/utils/workspaceRegistry.ts#L11-L32)). The token is a `randomUUID()` per window and is never rotated ([windowCoordinator.ts:88](../../src/windowCoordinator.ts#L88)).
- Every peer reads all files on each `list()` ([workspaceRegistry.ts:147-181](../../src/utils/workspaceRegistry.ts#L147-L181)), so the files must stay readable by the user's own windows.
- The control server binds 127.0.0.1 ([controlServer.ts:47](../../src/controlServer.ts#L47)). It checks method and path ([:72](../../src/controlServer.ts#L72)), then compares the header with `!==` ([:76](../../src/controlServer.ts#L76)). There is no Host or Origin check. The MCP endpoint has one ([debugMCPServer.ts:1177-1188](../../src/debugMCPServer.ts#L1177-L1188)), built from `isLoopbackHostHeader` / `isLoopbackOrigin` ([debugMCPServer.ts:41-63](../../src/debugMCPServer.ts#L41-L63)); the codebase review notes these helpers are untested.
- The router sends the token and lets Node set `Host: 127.0.0.1:<port>` ([routingDebuggingHandler.ts:148-158](../../src/routingDebuggingHandler.ts#L148-L158)). It caches the whole entry, token included, and `isLive` compares only pid and port ([routingDebuggingHandler.ts:23](../../src/routingDebuggingHandler.ts#L23), [workspaceRegistry.ts:255-259](../../src/utils/workspaceRegistry.ts#L255-L259)).

## Proposed fix

1. **File mode.** `writeFileAtomicSync(filePath, content, opts?: { mode?: number })` and the async twin create the temp file with `{ encoding: 'utf8', mode }`. The temp name is always new, so the mode applies (umask only removes bits), and the rename keeps the inode. Registry writes pass `0o600`. On win32 the mode is ignored and the per-user ACL of `%TEMP%` applies. The same option serves `default-target.json` from #16.
2. **Directory name.** A new pure function `resolveRegistryDir({ platform, tmpdir, uid, lstat })` in `workspaceRegistry.ts`, with its inputs injected:
   - `cmsis-developer-assistant-registry` when `tmpdir` is not world-writable. This covers macOS `$TMPDIR`, Windows `%TEMP%` and a folder in the home directory, and keeps today's name there, so mixed-version windows keep seeing each other.
   - `cmsis-developer-assistant-registry-<uid>` on POSIX when `tmpdir` has the o+w bit (Linux `/tmp`, macOS with `TMPDIR` unset). The name is the same for every window of the user, whoever created a directory first.
3. **Directory safety** (POSIX), in one `ensureRegistryDir()` used by `register` and `heartbeat`:
   - Create the directory with `mkdirSync(dir, { mode: 0o700 })`.
   - `lstat` it. It must be a directory, not a symlink, and owned by `process.getuid()`.
   - When we own it and `mode & 0o077` is set, `chmod 0o700`. This upgrades 2.3.10's 0755 directory on first start.
   - When it is foreign-owned or a symlink, do not register. Log an error and show one warning: "Multi-window routing is off in this window: `<dir>` belongs to another user." Another local user can force this state, but only by acting in the open, and the message names the directory.
4. **Existing files.** The heartbeat rewrites the window file within 20 s, which replaces 2.3.10's 0644 file with a 0600 one. Nothing else is migrated.
5. **Control-server gate**, checked in this order in `onRequest` ([controlServer.ts:71-79](../../src/controlServer.ts#L71-L79)):
   - Method and path, as today.
   - Host must be loopback (`isLoopbackHostHeader`). Any `Origin` header is refused, because the router never sends one.
   - The token: `typeof got === 'string' && got.length === token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token))`. The length check comes first because `timingSafeEqual` throws on unequal lengths. A header sent twice (a string array) counts as a mismatch.
   - `isLoopbackHostHeader`, `isLoopbackOrigin` and `LOOPBACK_HOSTNAMES` move from `debugMCPServer.ts` to a new `src/utils/loopback.ts`. Both servers import it, and the move brings their first tests.
6. **Point the reader at the right door.** The 403 and 404 bodies become JSON: `{"error": "internal endpoint of the CMSIS Developer Assistant; agents use the MCP tools list_debug_windows and select_debug_window"}`. The registry entry gains `"_note": "Internal to the CMSIS Developer Assistant. Agents: use the MCP tools list_debug_windows and select_debug_window."`. Readers ignore the field. It costs about 110 B per file and nothing in the tool list.
7. **Docs.**
   - `docs/architecture/debugMCPServer.md`, multi-window section: the directory rule, the modes and the gate order.
   - The contract line "the control server and registry are internal" ships with WP-D.
   - CHANGELOG, including: "Linux: reload every VS Code window after updating. A window that was not reloaded keeps using the old registry directory and is invisible to updated windows until it is reloaded." The name does not change on macOS or Windows.

## What changes for the agent and the user

```text
Before (2.3.10, Linux, shared /tmp)
  drwxr-xr-x alice /tmp/cmsis-developer-assistant-registry
  -rw-r--r-- alice   window-4711.json        {"controlPort":40721,"controlToken":"…"}  readable by every local user
  curl -X POST http://127.0.0.1:40721/op     → 403, empty body

After
  drwx------ alice /tmp/cmsis-developer-assistant-registry-1000
  -rw------- alice   window-4711.json        {"_note":"Internal … use list_debug_windows …", …}
  curl -X POST http://127.0.0.1:40721/op     → 403 {"error":"internal endpoint …; agents use the MCP tools list_debug_windows and select_debug_window"}
  curl -H 'Origin: http://evil.example' …    → 403 even with the right token
```

The agent's tool list is unchanged.

## Decisions for you

- [ ] **Linux directory.** **Recommended:** a per-uid name in `os.tmpdir()` whenever `tmpdir` is world-writable. `os.tmpdir()` is the same in every extension host of the user, so all windows agree. Alternative (the plan): `$XDG_RUNTIME_DIR`. It can be unset, or differ between extension hosts (Remote-SSH servers started without a login session, snap or flatpak builds), which would split windows that cannot see each other. Verification step if you prefer XDG: check its value under Remote-SSH and in the snap build.
- [ ] **Foreign-owned or symlinked directory.** **Recommended:** refuse to register and warn. Alternatives: a random fallback directory, which splits the windows; or keep using the directory, which keeps the leak.
- [ ] **Host and Origin check on the control server.** **Recommended:** yes, as in item 5. It is defence in depth only, because a browser cannot read the token. Alternative: token only, which is today's state.
- [ ] **`_note` field and explanatory 403 body.** **Recommended:** yes. The agent that `cat`s the registry or `curl`s the port reads the redirect where it looks. Alternative: silent 403, as today.
- [ ] **Token rotation.** **Recommended:** none. The router caches the entry including the token and re-checks only pid and port, so rotation would produce 403s mid-session. File modes already solve the cross-user case, and rotation cannot solve the same-user case. Alternative: rotate on every heartbeat, which needs a re-read-on-403 path in the router.

## Tests and acceptance

- `src/test/workspaceRegistry.test.ts`:
  - The window file is 0600 and a new directory is 0700 (skipped on win32).
  - An existing 0755 directory that we own is chmod'ed to 0700.
  - `resolveRegistryDir` picks the per-uid name for a world-writable `tmpdir` and the plain name otherwise (injected `lstat`/uid).
  - A foreign-owned or symlinked directory is refused and nothing is written.
- New `src/test/atomicFile.test.ts`: the `mode` option on the sync and async writers, and no temp file left behind on failure.
- New `src/test/loopback.test.ts`: the moved helpers (`localhost:3001`, `[::1]:3001`, `evil.com`, a missing Host, `Origin: null`).
- `src/test/routing.test.ts` (real `ControlServer`):
  - A wrong token of the same length, one of a different length and a doubled header each give 403 without throwing.
  - `Origin` present gives 403.
  - `Host: evil.example` gives 403.
  - A normal router forward still works.
  - The 403 body names `list_debug_windows`.
- `test/transport/two-window-routing.js` still passes unchanged: the router's Host is loopback.
- Live:
  - Linux VM with two users: user B cannot list user A's registry.
  - macOS: `ls -l` shows 0700 and 0600 after one heartbeat.
  - Windows: routing works as before.

## Out of scope and follow-ups

- Same-user isolation. The OS gives none without a separate account; the agent-facing answer is WP-D, #12 and #16.
- Future: serve the control channel on a Unix domain socket inside the 0700 directory, and on a named pipe with a user ACL on Windows. File permissions then authenticate the caller, and the token and the TCP port disappear. This needs a transport change on both sides and a mixed-version plan.
- Moving the registry out of the temp directory, for example to `globalStorage`. That would split VS Code, Insiders and Cursor windows, which share it today.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
