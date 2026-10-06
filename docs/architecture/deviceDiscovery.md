# Board/device catalog discovery

`discover_board_or_device` connects agent workflows to the public CMSIS Solution v2
catalog API. It answers board/device and pack questions before a project exists.
The debugging tools still own live target inspection; the documentation tools
still own manuals and register meanings.

`src/deviceDiscoveryHost.ts` activates `Arm.cmsis-csolution` lazily and checks
`getApi(2)`, `getBoards` and `getDevices`. It never calls project creation, build,
installation or hardware APIs. `src/core/deviceDiscovery.ts` is independent of
VS Code and owns matching, deadlines, decisions and response bounds. The small
structural interfaces describe the consumed public v2 subset without importing
extension internals. The existing debugging-handler operation table routes the
call to the selected window, so its extension version and catalog settings apply.

`src/deviceDiscoveryTools.ts` owns the MCP schema and registration. Literal
matching and candidate handling live in the pure core. Skills route to the tool
and to the existing identification workflow for unresolved facts.

Optional MCP inputs accept omission or `null`. The registration boundary converts
`null` to `undefined` before dispatch, so clients that require every field can
express a lookup without invented filters. Core requests keep their existing
types and defaults. Nonempty values remain literal filters; blanks are rejected
and wildcard or placeholder strings are not silently treated as omission.

The adapter makes no mutating API calls. Activating another extension can also run
that extension's normal startup behavior; the live activation/no-project-write
gate remains to be checked in an extension development host.

Names are literal, case-sensitive, and anchored by default. Broader `contains`
queries return candidates to confirm; no retry or fuzzy selection is automatic.
All returned identities participate in ambiguity decisions before output is
limited. Revision and vendor remain part of identity. Details are awaited only
after an exact selection, and each required property is read once per request.
Board-compatible devices are choices, not proof of the fitted silicon. The BSP
and selected device's DFP are resolved separately; equal pack identifiers appear
once in the pack list. A known device can support a DFP-only result when the
board search is empty. Processor names are never synthesized from core names.

The output distinguishes `resolved`, `ambiguous`, `unresolved` and `unavailable`.
Resolution concerns the returned catalog identities only. Public v2 does not
expose source completeness or hidden source errors. This fixed limitation belongs
in the tool description, not a per-result `coverage` field. An observed query
rejection can be reported as unavailable; an empty successful list cannot be
called a service failure or definitive absence of support. The adapter cannot
recover metadata conflicts already hidden by upstream source merging.

One deadline covers activation, list and detail requests. There is no public
cancellation API, so already-started upstream work may finish after a timeout;
the resolver starts no later stage after its deadline. Candidate and processor
lists are limited to 25 entries (10 by default), and a separate 16 kB UTF-8
budget refuses oversized results without shortening identifiers. Catalog
retrieval itself is not bounded by these output limits: upstream applies its
filters after fetching the catalog.

Tests: `src/test/deviceDiscovery.test.ts` and its fixture catalog exercise
correctness and deadlines. `test/transport/session-lifecycle.js` checks tool
registration, discovery without a workspace or debug session, and unavailable
API handling. The routing harness and surface snapshot cover the selected-window
dispatch and agent-visible schema. These tests use API-shaped mocks; they do not
establish live catalog performance or upstream extension activation behavior.
The transport check also compares omitted and null inputs after a constrained
call, ensuring that no previous filters persist within a session. This does not
verify a client's argument generation or compliance with the skill's retry limit.
