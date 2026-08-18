# Agent Guidelines for CMSIS-DebugMCP

## Project Overview

CMSIS-DebugMCP is a VS Code extension (fork of microsoft/DebugMCP) that embeds an MCP (Model Context Protocol) server, enabling AI coding agents to control VS Code's debugger via DAP. It specializes in Arm Cortex-M embedded debugging through the CMSIS Debugger extension (`gdbtarget` configurations) — reading memory, core registers, peripheral registers (via SVD), and decoding Cortex-M fault status — while retaining general multi-language debugging support.

### Architecture

```txt
AI Agent (Cline/Copilot/Cursor) → MCP/HTTP → DebugMCPServer → DebuggingHandler → DebuggingExecutor → VS Code Debug API
                                                                                                       │
                                                                                            ┌──────────┴──────────┐
                                                                                    gdbtarget (CMSIS)        other debug types
                                                                                            │
                                                                                   CDT GDB Debug Adapter
                                                                                            │
                                                                                    arm-none-eabi-gdb
                                                                                            │
                                                                                   pyOCD / J-Link GDB Server
                                                                                            │
                                                                                    SWD/JTAG → Cortex-M target
```

### Key Components

| Component | Responsibility | Docs |
| --------- | -------------- | ---- |
| `DebugMCPServer` | MCP server, tool/resource registration | [docs/architecture/debugMCPServer.md](docs/architecture/debugMCPServer.md) |
| `DebuggingHandler` | Operation orchestration, state change detection | [docs/architecture/debuggingHandler.md](docs/architecture/debuggingHandler.md) |
| `DebuggingExecutor` | VS Code debug API calls, DAP requests | [docs/architecture/debuggingExecutor.md](docs/architecture/debuggingExecutor.md) |
| `DebugState` | Debug session state model | [docs/architecture/debugState.md](docs/architecture/debugState.md) |
| `DebugConfigurationManager` | Launch configs, language detection | [docs/architecture/debugConfigurationManager.md](docs/architecture/debugConfigurationManager.md) |
| `AgentConfigurationManager` | AI agent auto-configuration | [docs/architecture/agentConfigurationManager.md](docs/architecture/agentConfigurationManager.md) |

## Documentation Maintenance

**IMPORTANT**: Keep `docs/*.md` files up to date when modifying components. These docs should remain high-level:

- Purpose and motivation
- Responsibility scope
- Key concepts and patterns
- Pointers to relevant code sections

Do NOT duplicate detailed implementation in docs - that information should be inferred from the code itself.

## File Header

Include in each source file:

```typescript
// Copyright (c) Microsoft Corporation.
```

## Build/Lint/Test Commands

| Command | Description |
| ------- | ----------- |
| `npm run compile` | Compile TypeScript to `out/` |
| `npm run lint` | Run ESLint on `src/` |
| `npm test` | Run all tests (`src/test/*.test.ts`) |
| `npm run watch` | Compile in watch mode |

## Code Style & Conventions

- **TypeScript**: Strict mode, ES2022 target, Node16 modules
- **Imports**: vscode → external packages → internal modules
- **Naming**: camelCase (variables/functions), PascalCase (classes/interfaces), `I` prefix for interfaces
- **Types**: Explicit types preferred, strict null checks, avoid `any`
- **Error Handling**: try-catch with descriptive messages, throw `Error` objects
- **Formatting**: Semicolons, curly braces for all control structures, tabs for indentation
- **Async**: async/await, exponential backoff for retries
- **Logging**: Use `logger` from `./utils/logger` (not `console.log`). Simple wrapper providing `info`, `warn`, `error` methods with consistent formatting.
- **VS Code API**: Import as `import * as vscode from 'vscode'`

## Key Dependencies

- `@modelcontextprotocol/sdk`: Official MCP server framework (`McpServer`, `SSEServerTransport`)
- `zod`: Schema validation for tool parameters
- `express`: HTTP server for SSE transport

## Entry Points

- **Extension activation**: `src/extension.ts` → `activate()`
- **MCP endpoint**: `http://localhost:{port}/mcp` (default port: 3001, Streamable HTTP transport)

## Configuration

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `cmsis-debugmcp.serverPort` | 3001 | MCP server port |
| `cmsis-debugmcp.timeoutInSeconds` | 180 | Operation timeout |

## Documentation Resources

The `docs/` folder contains two types of documentation:

**Component docs** (referenced in Key Components table above): Developer documentation for understanding the codebase architecture.

**AI Agent resources** (served via MCP at runtime):

| Resource URI | Source file | Purpose |
| ------ | --------- | --------- |
| `cmsis-debugmcp://docs/debug_instructions` | `agent-resources/debug_instructions.md` | Core debugging workflow guide |
| `cmsis-debugmcp://docs/cmsis-embedded-guide` | `agent-resources/cmsis-embedded-guide.md` | Cortex-M debugging expertise |
| `cmsis-debugmcp://docs/troubleshooting/embedded` | `agent-resources/troubleshooting/embedded.md` | Embedded-specific tips |
| `cmsis-debugmcp://docs/troubleshooting/<lang>` | `agent-resources/troubleshooting/<lang>.md` | Language-specific tips |

These resource files are loaded by `DebugMCPServer` and exposed as MCP resources that AI agents can read to learn how to use the debugging tools effectively.
