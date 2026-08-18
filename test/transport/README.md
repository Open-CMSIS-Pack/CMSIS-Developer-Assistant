# Transport harness

Drives the real `DebugMCPServer` over HTTP outside the extension host, with a
stubbed `vscode` module (`vscode-stub.js`, injected via a `Module._resolveFilename`
override). No board and no VS Code required.

```sh
npm run compile
node test/transport/session-lifecycle.js
node test/transport/two-window-routing.js
```

Each exits non-zero if any check failed.

## What `session-lifecycle.js` covers

- `POST /mcp` with an `initialize` request mints an `mcp-session-id`.
- `GET /mcp` carrying that id returns a live `text/event-stream`.
- `GET /mcp` with a missing or unknown id is rejected with **400**, not a bare
  404. This is the regression that made Cursor's MCP client tombstone the
  connection as "errored" while POST tool calls kept working.
- `tools/list` returns the full tool surface.
- **Three consecutive `get_threads` calls on one session all return.** This is
  the load-bearing check. The server originally shared one `McpServer` across
  requests and closed it per request, so a concurrent call stripped the other's
  transport and its response went nowhere — `get_threads` hung after the third
  call. The fix was per-request servers; moving to per-*session* servers (needed
  for the SSE stream and for routing) must not bring the hang back.
- `DELETE /mcp` tears the session down, and a `GET` after it is rejected.

Belongs here rather than in `src/test/` because it needs a real listening
socket, which the `vscode-test` Electron harness does not give us.

## What `two-window-routing.js` covers

Stands up two `WindowCoordinator`s against a shared temporary registry — the
same code path the extension uses — and drives the router over MCP:

- Exactly one window binds the well-known port; the other becomes a worker.
- Both windows advertise the **same** endpoint. A worker pointing agents at its
  own port is the misrouting bug this whole layer exists to fix.
- Both publish themselves to the registry, and `list_debug_windows` shows both.
- `select_debug_window` pins a session, and the pin is reflected back.
- Starting a debug session republishes the window as `debugging: <config>`,
  which is what makes path-less tools (`read_memory`, `cmsis_action`, `flash`)
  routable at all.
- Closing the router frees the port and a worker is promoted, so the agents'
  single URL survives the router window being closed.

Note: requests use `agent: false`. `server.close()` stops new connections but
leaves keep-alive sockets open, so a pooled socket to the disposed router would
otherwise be reused after failover and reset.
