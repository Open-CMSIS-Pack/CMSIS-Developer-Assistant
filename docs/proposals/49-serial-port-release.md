# #49 Release serial ports when they are no longer needed (idle, owner gone, session end) and add a one-shot serial_capture

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** Port leases, idle/session release and serial_capture are implemented; see [serial architecture](../architecture/serial.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#49](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/49) |
| Area · priority · source | Serial · Medium (proposed) · Maintainer |
| Original release plan | 2.3.11: honest state (WP-F, item 6). 2.3.12: release rules, `serial_capture` and the human handle (WP-K) |
| Size | L (WP-F XS) |
| Depends on | WP-F: none. WP-K: #11 (`ToolError`, `PORT_HELD`), #48 (journal, `notify`, the call context that carries the MCP session id), WP-G (tool-list bytes) |
| Related | #14 (internal ops next to `health`), #16 (`window` argument, status bar), #42 (teardown on deactivate) |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

`serial_open` holds a port exclusively until `serial_close`. On Windows the COM port is strictly exclusive, so after an agent session that forgot to close it, the Serial Monitor or a terminal gets "Access denied". Nothing in VS Code says who holds the port.

The issue's inventory is accurate for 2.3.10:

- Window teardown is the only automatic release; 2.3.10 bounds it to 2 s.
- The port's `close` and `error` events only log, so an unplug leaves a stale `path`, `baudRate` and `openedAt`.
- There is no owner, no idle timer, and no command for the user.

Three more facts:

- The router never learns that an MCP session ended unless the client sends `DELETE`. Even then it does not tell the worker windows, and sessions without `DELETE` never expire.
- The Serial Monitor bridge error text sends agents to a tool that does not exist, `serial_read_owned` ([serialMonitorBridge.ts:165](../../src/core/serialMonitorBridge.ts#L165)).
- The singleton has no port factory, which is why the existing test injects a fake port by hand.

## Current state (2.3.10)

- **One owned port per window** in the `serialController` singleton ([serialController.ts:198](../../src/core/serialController.ts#L198)).
  - `open` refuses a second port with prose ([:92-97](../../src/core/serialController.ts#L92-L97)).
  - `error` and `close` only log ([:111-112](../../src/core/serialController.ts#L111-L112)).
  - `close()` forgets the port even when closing fails ([:126-142](../../src/core/serialController.ts#L126-L142)).
  - The RX buffer is cleared only by a successful open ([:120](../../src/core/serialController.ts#L120)).
  - `read` polls every 25 ms ([:164-173](../../src/core/serialController.ts#L164-L173)).
  - `write` without a port throws "No serial port open" ([:144-147](../../src/core/serialController.ts#L144-L147)).
- **Bridge.** `subscribeIfAvailable` ([serialMonitorBridge.ts:151-177](../../src/core/serialMonitorBridge.ts#L151-L177)) and `unsubscribe` ([:179-184](../../src/core/serialMonitorBridge.ts#L179-L184)). Unsubscribing keeps the buffer.
- **Tools.** Registered at [debugMCPServer.ts:804-910](../../src/debugMCPServer.ts#L804-L910) behind `serial.enabled`, which is read once at activation ([extension.ts:48](../../src/extension.ts#L48), [debugMCPServer.ts:803](../../src/debugMCPServer.ts#L803)). They are implemented in [serialHandler.ts](../../src/serialHandler.ts) and routed as `SERIAL_OPS` ([opTable.ts:87-98](../../src/core/opTable.ts#L87-L98)).
- **Teardown.** `WindowCoordinator.dispose` closes the port and the bridge within 2 s ([windowCoordinator.ts:248-276](../../src/windowCoordinator.ts#L248-L276), `SERIAL_TEARDOWN_MS` [:70](../../src/windowCoordinator.ts#L70)).
- **Session end.**
  - `transport.onclose` only deletes the transport from the map ([debugMCPServer.ts:1225-1231](../../src/debugMCPServer.ts#L1225-L1231)). The per-session `RoutingDebuggingHandler` is never told.
  - The control envelope `{op, args}` carries no session id ([routingDebuggingHandler.ts:144](../../src/routingDebuggingHandler.ts#L144)).
  - The MCP session id reaches the tool wrapper only as `extra.sessionId` ([measuredMcpServer.ts:66](../../src/core/measuredMcpServer.ts#L66)).
- **Tool-list bytes**, measured on a scratch build of `f76aa8b`:
  - Single-window list: 28 799 B of the 30 000 B budget.
  - Routed list: 29 987 B, not measured by any test.
  - `serial_clear_buffer` costs 311 B.

## Proposed fix

### 2.3.11 (WP-F): honest state

1. In `open()`, the port's `close` handler resets `port`, `currentPath`, `currentBaud` and `openedAt`, like `close()` does.
   - It does so only when `this.port === p`, so a late `close` from an earlier port cannot clear a newer one.
   - A `DisconnectedError` (`err.disconnected === true`, serialport 13) is kept as `lastRelease = {path, at, reason: 'disconnected'}`.
   - The `error` handler does the same when `!p.isOpen`.
   - The RX buffer stays readable.
   - `serial_status` then reports "closed (COM7 disconnected at 10:42:07)", and `serial_read` / `serial_write` name the reason instead of "no port open".
2. Export the class and give it a constructor with an injectable port factory and clock: `new SerialController({ createPort?, clock? })`. Tests can then use serialport's own `SerialPortMock` and `MockBinding`. The singleton keeps the defaults.
3. Fix the `serial_read_owned` text to `serial_open / serial_read`. #49 stays open for WP-K.

### 2.3.12 (WP-K): release rules, capture, handles

1. **`serial_capture {path, baudRate?, durationMs, until?, write?}`** in `SerialHandler` (new op `handleCapture` in `SERIAL_OPS`):
   - It opens the port in the window's owned slot, so `serial_status` shows it meanwhile. It then writes `write` (utf8) and reads until the regex `until` matches the decoded text, or until `durationMs` (100–60 000). The port is closed in `finally` on success, timeout, a throwing read, and an invalid regex.
   - The result is at most 16 kB: the first 8 kB and the last 8 kB, with "… N bytes omitted …" between them. It adds the stop reason ("matched /READY/", "deadline") and the elapsed time.
   - `PORT_HELD` when:
     - The slot is taken in this window. The hint reads "serial_read {waitMs} reads the open port; serial_close it to use serial_capture".
     - The OS refuses: Windows "Access denied", POSIX `EBUSY` / "Cannot lock port". The hint reads "another program holds it (Serial Monitor, a terminal); close it, or serial_subscribe_monitor".
   - The description tells agents to prefer it for "show me what the board prints".
2. **Idle release.**
   - New setting `cmsis-developer-assistant.serial.idleCloseSeconds`: number, default 300, minimum 0 (0 disables it), window scope. It is read at each open, so no reload is needed.
   - `serial_read`, `serial_write`, `serial_status` and `serial_capture` restart the timer. RX traffic does not: "in use" means an agent is asking.
   - On expiry the port closes and the buffer stays. The next `serial_read` returns the buffered bytes plus "COM7 was closed at 10:47 after 300 s without a serial call; reopen with serial_open". The next `serial_write` throws `ToolError('PORT_CLOSED')` (see Decisions) with the same text.
3. **Owner-bound release.**
   - `serial_open` records the owner, the MCP session id. It comes from #48's call context, and `RoutingDebuggingHandler.forward` sends it as the envelope's `sessionId`.
   - The router remembers the pids each session forwarded to.
   - `DebugMCPServer` keeps `{transport, handlers, lastSeenAt, openStreams}` per session and ends a session:
     - on `transport.onclose` (`DELETE`), or
     - when the session has had no request for 30 min and holds no open GET stream. The sweep runs every 60 s and closes the transport. A later request with that id gets 404 (#14 item 7), so the client re-initializes.
   - On session end the router posts the internal op `sessionEnded {sessionId}` to those windows, fire-and-forget with a 2 s timeout. The worker closes the ports and the bridge subscription that this session owns. An old worker answers "Unknown control op" and is ignored. The single-window server calls the local serial handler directly.
4. **`releaseOn` on `serial_open`:**
   - `'idle'` (default): the idle timer, owner gone and teardown.
   - `'debug-session-end'`: `onDidTerminateDebugSession` in this window, owner gone and teardown.
   - `'manual'`: only `serial_close`, the user's Release command and teardown. It survives the owner going away, for soak tests.
5. **Human handle.**
   - While a port is held, a status-bar item `cmsis-developer-assistant.serial` shows "$(plug) Serial: COM7 (agent)". Its tooltip gives the path, baud rate, since, owner (short id), `releaseOn` and "idle release in 3 min".
   - Clicking it runs the command `cmsis-developer-assistant.releaseSerialPort`, titled "CMSIS Developer Assistant: Release Serial Port". The command releases the port with reason `user` and confirms with an information message.
   - Every release (disconnected, idle, owner gone, debug end, user) writes one output-channel line and one journal record (`source: 'serial'`; warning for disconnected and user, info otherwise). Payload is never journaled.
6. **Bridge.** The same idle and owner rules apply to the Serial Monitor subscription, which unsubscribes and drops its buffer.
7. **Tell the agent.**
   - `get_session_status` adds "Serial: COM7 open (this session, idle 42 s of 300 s)" or "Serial: COM7 released after idle at 10:47".
   - The `serial_open` description adds "Released after 300 s without a serial call or when this session ends; prefer serial_capture for one-off reads".
   - `skills/cmsis-debug-live/SKILL.md` adds three lines: prefer `serial_capture`; for serial around a reset use `serial_open` → `reset` → `serial_read {waitMs}` → `serial_close`; close as soon as the output is read.
   - The new-tool checklist (allowed-tools, `help.toolGroups`, `cmsis-help`, README, CHANGELOG) applies. The pinned serial tool count in `session-lifecycle.js` stays 10 when WP-G folds `serial_clear_buffer` into `serial_read {clear}`.
8. **`flash` and `cmsis_action load | erase | load_and_run`** add one line when a port is held: "COM7 is open in this window; if the probe's VCP re-enumerates during programming, reopen it". No automatic release (Decisions).

**Byte cost** (SDK 1.26 serializer, draft descriptions):

| Change | Bytes |
|---|---|
| `serial_capture` | +970 |
| `releaseOn` | +135 |
| `serial_open` description | +60 |
| `serial_read {clear}` minus `serial_clear_buffer` (WP-G) | −234 |

The net is about +930 B, paid in WP-G. The `window` argument on `serial_open` and `serial_capture` is counted in #16.

## What changes for the agent and the user

```text
Before
  agent: serial_open {path:"COM7"} … serial_read … (conversation ends)
  user:  Serial Monitor → "Opening COM7: Access denied"   — until a window reload
  unplug: serial_status → "Owned serial: closed" but path/baud/openedAt still set

After
  agent: serial_capture {path:"COM7", durationMs:3000, until:"READY"}
         → "Captured 412 B in 1.2 s (matched /READY/). Port closed." + text
  agent forgot serial_close: port released 300 s after the last serial call, or at once when the MCP client disconnects
  user:  status bar "$(plug) Serial: COM7 (agent)" → click → released
  agent: serial_read → buffered bytes + "COM7 was closed at 10:47 after 300 s without a serial call; reopen with serial_open"
  unplug: serial_status → "closed (COM7 disconnected at 10:42:07)"
```

## Decisions for you

- [ ] **Idle default, and a per-open `idleSeconds`?** (open question 1) **Recommended:** 300 s through the setting, with no per-open parameter. Soak tests use `releaseOn: 'manual'`. Alternative: `idleSeconds` on `serial_open`, about +100 B for a case the setting and `manual` already cover.
- [ ] **Should `flash` / `cmsis_action load` release the port first?** (open question 2) **Recommended:** not in 2.3.12. Knowing that COM7 belongs to *this* probe needs the USB serial number to be matched to the probe UID. The WP-F state fix plus the one-line note in the result handle the re-enumeration. Alternative: close any held port before programming. It is simple, but it also cuts an unrelated second board's UART.
- [ ] **One owned port per window?** (open question 3) **Recommended:** keep it. Several ports need an owner-per-port model and a `path` on every serial tool. Alternative: a follow-up issue.
- [ ] **Can `serial_capture` trigger the reset itself** (`reset: true`, which runs the live session's `reset {halt:false}` after the port is open)? **Recommended:** not in 2.3.12. The serial handler would call into the debug handler, and it only works with a live session; the four-call pattern plus idle release covers it. Alternative: add it, about +110 B, if the evals show agents fumbling the four-call pattern.
- [ ] **Error code for a write on a released or closed port.** **Recommended:** add `PORT_CLOSED` to #11's `ErrorCode`. `INVALID_ARGUMENT` would tell the agent its arguments are wrong. Alternative: `INVALID_ARGUMENT` with the reason in the hint, which leaves the vocabulary unchanged.
- [ ] **Session TTL.** **Recommended:** 30 min without a request, and only when no GET stream is open. It relies on #14's 404 so that clients re-initialize transparently. Alternative: release only on `DELETE`, which never fires for clients that just disconnect.

## Tests and acceptance

- **2.3.11**, `src/test/serialController.test.ts` with `SerialPortMock`:
  - A `close` event carrying `DisconnectedError` clears `path`, `baudRate` and `openedAt`, keeps the buffer, and records `lastRelease`.
  - A late `close` from a replaced port does not clear the new one.
  - The existing close-failure tests still pass.
- **2.3.12**, `src/test/serialController.test.ts` and new `src/test/serialHandler.test.ts`:
  - The idle timer (fake clock): it releases, the buffer stays readable, and read, write and status restart it.
  - The `releaseOn` matrix.
  - Owner-gone closes only the owner's port, and never a `manual` one.
  - `serial_capture` closes on an `until` match, on the deadline, on a throwing read and on an invalid regex.
  - `PORT_HELD` for a held slot and for OS refusals.
  - Fixture paths `COM7`, `\\.\COM12`, `/dev/cu.usbmodem1102`, `/dev/tty.usbmodem1102`, `/dev/ttyACM0`.
  - The Windows "Access denied" and POSIX `EBUSY` message mapping.
- `src/test/routing.test.ts`:
  - `sessionId` is in the envelope.
  - `sessionEnded` goes only to the windows the session touched.
  - An old worker's "Unknown control op" is ignored.
- `test/transport/session-lifecycle.js`:
  - `DELETE` triggers the local `sessionEnded`.
  - TTL expiry (injected clock) gives 404 on the old id.
  - The serial tool count stays 10 and the budgets hold.
- Live:
  - Windows: an agent opens COM7 and the chat is closed. The Serial Monitor opens COM7 at once.
  - With the client still connected, the port is free after 300 s.
  - Unplug the board: `serial_status` reports disconnected with no stale path.
  - The status-bar click releases the port.

## Out of scope and follow-ups

- Several owned ports per window.
- Matching VCP ports to probes by USB serial number, which would enable a release before programming.
- A handoff to the Serial Monitor: opening the user's Serial Monitor on the released port.
- The shared `RxBuffer` extraction from the codebase review (the `serialController` and `serialMonitorBridge` reads are identical). Do it before WP-K if phase 3 of the review has landed; it is not required.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
