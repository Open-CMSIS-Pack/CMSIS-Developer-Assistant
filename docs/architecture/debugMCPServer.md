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
| `cmsis-debugmcp://docs/debug_instructions` | General debugging guide |
| `cmsis-debugmcp://docs/cmsis-embedded-guide` | Cortex-M debugging expertise |
| `cmsis-debugmcp://docs/troubleshooting/embedded` | Embedded-specific troubleshooting |
| `cmsis-debugmcp://docs/troubleshooting/*` | Language-specific tips |

## Configuration

- `cmsis-debugmcp.serverPort`: Port number (default: 3001)
- `cmsis-debugmcp.timeoutInSeconds`: Operation timeout (default: 180)