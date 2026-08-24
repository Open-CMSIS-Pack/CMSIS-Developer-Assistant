# DebugMCPServer

## Purpose

The MCP server component that exposes VS Code debugging capabilities to AI agents via the Model Context Protocol. This is the main entry point for all external AI agent communication.

## Motivation

AI coding agents need a standardized way to control debuggers programmatically. MCP provides this standard, and `DebugMCPServer` implements it using the official `@modelcontextprotocol/sdk` with Streamable HTTP transport over an express HTTP server.

## Responsibility

- Initialize and manage the MCP server lifecycle (using `McpServer` from `@modelcontextprotocol/sdk`)
- Register debugging tools that AI agents can invoke
- Register documentation resources for agent guidance
- Delegate all debugging operations to `DebuggingHandler`
- Manage Streamable HTTP transport via `StreamableHTTPServerTransport` on configurable port (default: 3001)

## Architecture Position

```
AI Agent (MCP Client)
        │
        ▼ HTTP POST /mcp
┌───────────────────┐
│  DebugMCPServer   │  ◄── You are here
│ (express + HTTP)  │
└───────────────────┘
        │
        ▼ Delegates to
┌───────────────────┐
│ DebuggingHandler  │
└───────────────────┘
```

## Key Concepts

### Tools vs Resources

- **Tools**: Actions the AI can perform (start debugging, step over, etc.)
- **Resources**: Documentation the AI can read for guidance (note: some clients like GitHub Copilot don't support resources, so the `get_debug_instructions` tool is also provided)

### Streamable HTTP Transport

Uses stateless HTTP POST requests for MCP communication. The express server exposes:
- `POST /mcp` — Handles all MCP protocol messages (JSON-RPC over HTTP)

Each request creates a new `StreamableHTTPServerTransport` instance in stateless mode, which is cleaned up when the response closes. This approach is simpler than session-based transports and works well with standard HTTP clients.

## Key Code Locations

- Class definition: `src/debugMCPServer.ts`
- Tool registration: `setupTools()` method (uses `McpServer.registerTool()`)
- Resource registration: `setupResources()` method (uses `McpServer.registerResource()`)
- Server startup: `start()` method (creates express app with SSE/message routes)

## Exposed Tools

| Tool | Description |
|------|-------------|
| `get_debug_instructions` | Get debugging guide (for clients that don't support resources) |
| `start_debugging` | Start a debug session (supports `configurationName` passthrough for CMSIS `gdbtarget` configs) |
| `stop_debugging` | Stop current session |
| `step_over/into/out` | Stepping commands |
| `continue_execution` | Continue to next breakpoint |
| `restart_debugging` | Restart session |
| `add/remove_breakpoint` | Breakpoint management |
| `clear_all_breakpoints` | Remove all breakpoints |
| `list_breakpoints` | List active breakpoints |
| `get_variables_values` | Inspect variable values |
| `evaluate_expression` | Evaluate expressions (GDB MI via DAP `evaluate` with `context: 'repl'`) |
| `read_memory` | Read bytes from target memory (DAP `readMemory` + GDB fallbacks) |
| `read_core_registers` | Read Cortex-M core registers (R0-R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK) |
| `read_peripheral_register` | Read peripheral registers using SVD (Peripheral Inspector API or SVD fallback) |
| `get_fault_info` | Read and decode CFSR / HFSR / DFSR / MMFAR / BFAR / AFSR |
| `get_device_info` | Summarize active session — device, probe, processor, GDB server |

## Exposed Resources

| URI | Content |
|-----|---------|
| `cmsis-developer-assistant://docs/debug_instructions` | General debugging guide |
| `cmsis-developer-assistant://docs/cmsis-embedded-guide` | Cortex-M debugging expertise |
| `cmsis-developer-assistant://docs/troubleshooting/embedded` | Embedded-specific troubleshooting |
| `cmsis-developer-assistant://docs/troubleshooting/*` | Language-specific tips |
| `cmsis-developer-assistant://stats` | Tool-call statistics as JSON: per-tool calls, bytes in/out, time and outcomes for the session and for the server instance, plus the last 50 samples |

## Configuration

- `cmsis-developer-assistant.serverPort`: Port number (default: 3001)
- `cmsis-developer-assistant.timeoutInSeconds`: Operation timeout (default: 180)

### Server options

`debugMCPServer.ts` deliberately does not import `vscode`, so it can run headless under `test/transport/vscode-stub.js`. Anything the server needs from settings therefore arrives through the constructor: the port, the operation timeout, the hardware timeouts, the per-session handler factory, and a trailing `DebugMCPServerOptions` object. `WindowCoordinator` passes that object through as `CoordinatorOptions.serverOptions`; `extension.ts` fills it from the settings it reads once at activation.

The options are fixed for the lifetime of a server instance and are read when each MCP session's `McpServer` is built at `initialize`. A consumer must never toggle behaviour per call on them — the tool list a client sees has to stay stable between turns, or the client's prompt cache is invalidated on every request. A changed setting therefore takes effect for the next MCP client connection after a window reload, the same way `serverPort` does.

| Field | Consumed by |
|-------|-------------|
| `serialEnabled` | Registration of the `serial_*` tools (issue #23) |
| `telemetry.jsonlPath` | The tool-call telemetry file sink (see below) |

`getOptions()` returns the object read-only, for tests and for later consumers.

## Tool call telemetry

Every session's `McpServer` is a `MeasuredMcpServer` (`src/core/measuredMcpServer.ts`), whose `registerTool` wraps each callback. The wrapper sits at the MCP boundary, so it measures what the client experiences: argument bytes after schema parsing, result bytes as handed to the transport (after every handler, redaction and routing step), wall time including a forward to another window, and the outcome — `ok`, `timeout` (a handler that returned its fence text instead of finishing) or `error` (a thrown error or an `isError` result), classified by `classifyOutcome` in `src/core/toolMetrics.ts`.

One `ToolMetrics` ring per session feeds three consumers: the `cmsis-developer-assistant://stats` resource and the two-line trailer on `get_session_status` report the session; the instance-wide aggregate (`getMetrics()`) keeps every session; an INFO line per call goes to the output channel, and, when `telemetry.jsonlPath` is set, one JSON line per call goes to that file (names and sizes only — never arguments or results). The worker side logs a matching `control op=… ms=…` line in `ControlServer.dispatch`, so a slow call can be attributed to the window that did the work or to the hop. `test/realboard/run.ts` reads the stats resource into its report.
