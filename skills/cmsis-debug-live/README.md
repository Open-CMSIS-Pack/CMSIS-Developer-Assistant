# cmsis-debug-live

The Agent Skill that ships with CMSIS Developer Assistant. It encodes the *workflow* for
driving a live Cortex-M debug session; the MCP server itself only exposes tools
with short behavioural descriptions.

Install location follows the [Agent Skills](https://agentskills.io) convention:
the extension copies this directory to `~/.agents/skills/cmsis-debug-live/`, to
`~/.claude/skills/cmsis-debug-live/` when a Claude home exists, and to
`$COPILOT_HOME/skills/` when that variable is set. That happens on every
activation for every skill selected in the `installedSkills` setting — this
one is selected by default. The other skills in the catalog are described in
[`../README.md`](../README.md).

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

## Live trigger evaluation

`npm run test:skill-trigger-agent` launches a real Copilot CLI session in a
scratch worktree that carries only this skill, gives it an embedded
"it does not work on the board" prompt (a HardFault with an ADC buffer that is
right on the FVP and wrong on hardware), and asserts from the JSON tool events
that `cmsis-debug-live` is the first tool invoked. The static contract tests in
`src/test/debugSkillGuidance.test.ts` pin the wording that makes that happen.

It is opt-in on purpose: it needs an authenticated Copilot CLI, spends AI
credits, and a model's first move is not deterministic.

`npm run eval:scenario -- <id>` goes one step further: it runs the agent on a
planted bug in a real csolution (Corstone-300 FVP) with this skill and the MCP
server, and reports tool calls, bytes, turns, time and a pass/fail against the
expected root cause — see `test/eval/README.md`.

Pass a different prompt after `--`:

```text
npm run test:skill-trigger-agent -- "The UART stops transmitting after the first DMA transfer"
```
