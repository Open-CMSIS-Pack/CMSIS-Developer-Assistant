[![License Apache-2.0 OR MIT](https://img.shields.io/badge/License-Apache--2.0%20OR%20MIT-green?label=LICENSE)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/main/LICENSE)
[![CI Build and Test](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/CMSIS-Developer-Assistant/ci.yml?logo=arm&logoColor=0091bd&label=CI%20Build%20and%20Test)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/actions/workflows/ci.yml?query=branch:main)

# CMSIS Developer Assistant

![CMSIS Developer Assistant workflow](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/raw/main/docs/cmsis-developer-assistant.png)

The CMSIS Developer Assistant gives an AI agent controlled access to the CMSIS build
system, debugger, target registers, project documentation, and connected
hardware. The AI agent becomes more than a code generator: it can participate in
the complete embedded development lifecycle while you remain in control.

Traditional embedded development is a human-driven loop: understand the
requirements, configure the project, write code, build, flash, debug, analyze,
and repeat. AI-supported development changes where you spend your time. You
define the goal, agree on the specification and test criteria, and review the
result. Your AI coding agent can take on much of the repetitive loop: plan,
implement, build, deploy, observe the real hardware, reason about failures, and
iterate.

## What you can do

- **Turn intent into working embedded software.** Start with a goal and let the
  agent help plan, create, integrate, and verify the implementation.
- **Work across the CMSIS ecosystem.** Bring projects, software packs, tools,
  documentation, and target hardware into one guided workflow.
- **Close the loop on real hardware.** Build and deploy software, observe its
  behavior on the target, reason about failures, and iterate against test
  criteria.
- **Apply expert knowledge.** The knowledge base contains thousands of
  CMSIS and Zephyr topics, including procedures, concepts, rules, examples, and
  troubleshooting guidance; the agent searches it before starting a task.

> &#128204; **TIP**
>
> **Working with Zephyr:** use a csolution project to describe the selectable
> Zephyr applications, build configurations, and target hardware. Zephyr and
> `west` still configure and build the application, while CMSIS adds the project,
> programming, debug, peripheral, and trace information used by the development
> tools. See the
> [CMSIS-Zephyr examples](https://github.com/Arm-Examples/CMSIS-Zephyr).

## How it works

The extension combines three complementary capabilities:

- **Knowledge** gives agents indexed guidance for CMSIS and Zephyr development,
  including procedures, concepts, rules, examples, and troubleshooting. The
  agent searches and reads the relevant topics through the `knowledge_search`,
  `knowledge_get`, and `knowledge_expand` tools, scoped to the active target.
  One installed AI Skill, `cmsis-help`, is the entry point and health check.
- **MCP tools** let agents perform those workflows through VS Code: build and
  flash, control the debugger, inspect the target, use serial ports, and read
  project documentation and build artifacts.
- **Target context** gives the agent device- and project-specific knowledge from
  the CMSIS solution, generated build and run descriptions, software packs,
  SVD files, examples, and linked documentation. This lets the agent use the
  configuration and tools selected by the project instead of rediscovering or
  guessing them.

Together, these capabilities help the agent follow repeatable workflows, use
the established CMSIS tools, and base its decisions on the actual target and
project configuration.

The extension helps configure supported coding agents, installs the
`cmsis-help` entry skill, and provides the indexed knowledge base. Installed
software packs can extend the knowledge base with target-specific content.
GitHub Copilot in VS Code discovers the MCP server automatically.
The integration has been tested with Codex, Claude Code, GitHub Copilot, and Kimi Code.
Other agents that support MCP may also work; the Agent Skills format adds the
`/cmsis-help` entry point.

## Requirements

CMSIS Developer Assistant is free to use and works in combination with:

- [CMSIS Solution](https://marketplace.visualstudio.com/items?itemName=Arm.cmsis-csolution) to
  create, configure, and build CMSIS solutions.
- [CMSIS Debugger](https://marketplace.visualstudio.com/items?itemName=Arm.vscode-cmsis-debugger) to
  program and debug Arm Cortex-M targets.
- An AI coding agent that supports MCP; the
  [Agent Skills](https://agentskills.io/) format adds the `/cmsis-help` entry
  point.

## Get started

1. Install [Arm Keil Studio](https://marketplace.visualstudio.com/items?itemName=Arm.keil-studio-pack) and CMSIS Developer Assistant in VS Code.
2. Open the [command palette](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette) and run
   **CMSIS Developer Assistant: Configure Agent**.
3. In your agent's chat window, describe the outcome you want. For example, ask
   the agent to work with an open CMSIS solution or to create one from an empty
   VS Code window. `/cmsis-help` checks the setup and names the procedure for
   a task (see [Explore the knowledge base](#explore-the-knowledge-base)).

> &#128204; **TIP**
>
> [**Webinar: Getting Started with AI: A New Level of Productivity for Embedded
> Developers**](https://developer.arm.com/embedded-and-microcontrollers/ai-assisted-embedded-development)
> shows how CMSIS Developer Assistant and Keil Studio accelerate Cortex-M
> development, from understanding hardware and creating projects to building,
> debugging, and verifying firmware.

## Supported development tasks

CMSIS Developer Assistant supports these embedded development activities:

- Creating and extending CMSIS and Zephyr projects.
- Finding boards, devices and their examples in the CMSIS catalog, creating a
  project from an example, and installing the verified device and board packs.
- Adding targets, boards, layers, startup code, standard I/O, and debugger
  configuration.
- Building, programming, running, attaching to, and debugging Cortex-M
  firmware.
- Diagnosing HardFaults, crashes, hangs, peripheral failures, and timing issues.
- Inspecting memory, registers, variables, call stacks, SVD peripherals, and
  cycle counts.
- Searching target manuals, datasheets, errata, and Arm documentation with page
  citations.
- Analyzing ELF symbols, memory usage, linker sections, build logs, and errors.
- Creating GitHub Actions for CMSIS solution builds and optional FVP tests.
- Communicating with target hardware over serial ports.
- Troubleshooting pyOCD, J-Link, debug probes, Flash programming, and Arm FVP
  sessions.

Example prompts:

- > Which peripherals are used by this application?
- > Create a board layer that separates peripheral interfaces from
  > application logic.
- > Find out why the application enters the HardFault handler and propose a
  > fix.
- > Check whether the GPIO output toggles at the required rate and iterate
  > until the test passes.

## How you stay in control

You set the goal, approve the specification, and decide when the result is
ready. The lifecycle below shows how the agent handles the implementation loop
while you retain the key review and approval points.

![AI Supported Development Lifecycle](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/raw/main/docs/ai-development-lifecycle.png)

Following that lifecycle, a typical workflow is:

1. **Define the goal.** Describe the intended outcome and relevant constraints.
2. **Create and review a specification.** Ask the agent to define requirements,
   interfaces, and measurable test criteria before implementation begins.
3. **Implement and iterate.** Let the agent plan the work, modify the software,
   build and deploy it, observe the real hardware, and reason about failures
   until the agreed criteria are met.
4. **Verify the result.** Review the code and the evidence from builds, tests,
   and target observations before accepting and delivering the result.

The agent works through the same CMSIS project and debugger integrations that
you use in VS Code. Source changes, build output, debug state, and tool results
remain available for review. Actions that affect the target, such as programming
Flash or changing execution state, are explicit MCP tool calls and remain
subject to your coding agent's approval settings.

The MCP server listens only on the local machine. It does not expose the
debugger or connected target to the network. Your chosen AI coding agent may
process prompts and tool results according to that agent's own service and
privacy terms.

## Help and feedback

- Enter in the agent chat window `/cmsis-help` or ask “What can I do with CMSIS Developer Assistant?”
- Report problems and request features in
  [GitHub Issues](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues).
- Use **CMSIS Developer Assistant: Copy Recent Problems** to collect relevant
  errors and warnings when reporting a problem.
- See the [user guide](docs/user-guide.md) for the full tool reference, settings,
  agent registration, and troubleshooting.
- See [CHANGELOG.md](CHANGELOG.md) for release notes.
- Report security vulnerabilities as described in
  [SECURITY.md](SECURITY.md).

## Commands

Open the
[command palette](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette)
and type **CMSIS Developer Assistant** to find the commands below. Every command
name is prefixed with **CMSIS Developer Assistant:**.

| Command | What it does |
|---------|--------------|
| **Configure Agent** | Register selected AI agents, install the `cmsis-help` skill, and optionally add tool rules to agent instruction files. |
| **Select Target Window** | Choose which VS Code window receives agent calls, or use automatic selection. |
| **Release Serial Port** | Return an agent-held serial port to the Serial Monitor or another application. |
| **List Target Documentation** | List the current target's manuals, datasheets, Arm documents, and imported PDFs. |
| **Index Target Documentation** | Index all target PDFs now so searches are immediately available. |
| **Import Document for Current Target** | Import and attribute PDFs that are not supplied by a software pack. |
| **Open User Documents Folder** | Open the folder containing imported target documentation. |
| **Open Pack Docs Panel** | Inspect target documents, SVD peripherals, index state, and documentation tools. |
| **Open Knowledge Browser** | Search the knowledge base and explore relationships between topics. |
| **Copy Recent Problems** | Copy recent errors and warnings, with their source and suggested next step. |

## Explore the knowledge base

The extension ships an indexed knowledge base containing thousands of topics
for CMSIS and Zephyr development. It combines built-in content with knowledge
from installed software packs and the current workspace, allowing searches to
return guidance specific to the selected target.

Each topic is a knowledge unit: a self-contained procedure, concept, rule,
example, or troubleshooting guide with metadata and relationships to related
units. Together, these units connect a task or error message to the guidance
needed to address it.

AI agents are instructed to search the index before CMSIS and Zephyr tasks and
retrieve only the knowledge relevant to the current task and target. The
installed `cmsis-help` skill is the entry point and health check; enter
`/cmsis-help`, or simply describe the outcome you need.

For direct access, run **CMSIS Developer Assistant: Open Knowledge Browser**.
It lets you search the complete collection, read individual units, explore
their relationships, and inspect index metadata.

The knowledge base explains how to approach a task. The documentation search
described next complements it with evidence from the manuals and datasheets for
the selected target hardware.

## Documentation RAG

Reliable embedded development depends on the exact documentation for the
selected device and board. Register definitions, peripheral behavior, hardware
constraints, and errata can vary between device families and revisions. Access
to the relevant manuals lets the AI agent ground its guidance in authoritative,
target-specific evidence instead of relying on generic assumptions.

The CMSIS Developer Assistant includes a local **retrieval-augmented generation
(RAG)** system for querying technical documentation relevant to the current
CMSIS target. It discovers target-specific manuals and PDFs, extracts their
content, and indexes it for lexical search, giving additional weight to
headings. RAG finds the most relevant passages for a question and supplies them
to the AI agent as context, making large documentation sets practical to use.

Through MCP tools, the AI agent can search and retrieve relevant documentation
pages and CMSIS-SVD peripheral information. Because retrieval and indexing are
local and scoped to the selected target, the system is lightweight and well
suited to precise queries about devices, registers, bit fields, and other
embedded-software terminology.

> &#8505;&#65039; **IMPORTANT**
>
> Many CMSIS Device Family Packs (DFPs) and Board Support Packs (BSPs) reference
> manuals for their devices or boards. In some cases, the CMSIS Developer
> Assistant cannot access those documents directly.
>
> Use **CMSIS Developer Assistant: Open Pack Docs Panel** to see which documents are available to the AI
> agent. If a required manual is missing, download a copy and add it with
> **CMSIS Developer Assistant: Import Document for Current Target**.

Documentation tools are enabled by default. Disabling
[`cmsis-developer-assistant.packDocs.enabled`](https://code.visualstudio.com/docs/configure/settings#_extension-settings)
removes them from the AI agent's tool list after the VS Code window is reloaded.

## Working with multiple VS Code windows

In this context, a window is a separately opened VS Code window, whether it
contains a workspace or is empty. Each has its own extension host and may have
its own workspace folders, projects, and debug sessions. One window acts as the
router and forwards AI agent requests to the appropriate window. Other windows
act as workers and run requests for their own projects and debug sessions.
Router election and target-window selection are automatic in most cases.

The CMSIS Developer Assistant status-bar item shows **R** for the router and
**W** for a worker. Click it, or run **CMSIS Developer Assistant: Select Target
Window**, to choose which window the agent should use.
