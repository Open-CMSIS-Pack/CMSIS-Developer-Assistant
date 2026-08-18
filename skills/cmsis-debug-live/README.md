# cmsis-debug-live

The Agent Skill that ships with CMSIS-DebugMCP. It encodes the *workflow* for
driving a live Cortex-M debug session; the MCP server itself only exposes tools
with short behavioural descriptions.

Install location follows the [Agent Skills](https://agentskills.io) convention:
the extension copies this directory to `~/.agents/skills/cmsis-debug-live/`, and
also to `~/.copilot/skills/cmsis-debug-live/` when a Copilot home exists. That
happens automatically when you register CMSIS-DebugMCP with an agent.

Invoke it as `/cmsis-debug-live` in harnesses that support skills.

## Layout

| Path | Contents |
|---|---|
| `SKILL.md` | The workflow: target awareness, the session-status gate, the inspect loop, fault decode, multi-window routing, root-cause discipline. |
| `references/cmsis-embedded-guide.md` | SCS memory map, fault-decode recipes, common register layouts, RTOS notes. |
| `references/troubleshooting/embedded.md` | Probe not detected, target not halted, SVD missing, wrong core on multi-core parts. |
| `references/troubleshooting/cpp.md` | C/C++ specifics that also apply to firmware. |

The per-language troubleshooting files upstream ships (Python, Java, Go,
JavaScript, C#) are deliberately absent — none of them run on a Cortex-M.

## Relationship to `get_debug_instructions`

The `get_debug_instructions` tool returns
[`docs/agent-resources/debug_instructions.md`](../../docs/agent-resources/debug_instructions.md),
which stays in the server for harnesses that do not load skills — notably
GitHub Copilot Chat, which reads MCP tools but not `~/.agents/skills`.

The two overlap on purpose. The skill is the version an agent gets *before* it
starts calling tools; the tool is the fallback for agents that only discover
things by calling them. Keep them consistent when either changes.
