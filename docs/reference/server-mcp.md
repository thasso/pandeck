# Server tool layer and MCP — implementation reference

Relocated from `app/server/src/mcp/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

The app's harness-neutral tool layer: the `AgentTool` interface, the generic
per-session MCP server (mounted by the Claude harness; the future external MCP
surface), and the browser tool groups (native + proxied external MCP server
tools). The pi harness consumes AgentTools directly via
`piSdk/agentToolAdapter.ts` — not through this server.

## Module ownership

- `tool.ts` owns the `AgentTool`/`ToolResult`/`ToolCallContext`/`ToolSession`
  contracts, including the `sideEffects` axis, and helpers (`defineAgentTool`,
  `jsonResult`, `uniqueAgentTools`, the shared Plan denial message).
- `meta.ts` owns the MCP `_meta` key contract: `pa/*` keys that no in-repo
  client sends or reads, honoured for a possible external MCP client
  (`pa/toolCallId`, `pa/terminate`, `pa/details`, `pa/pi`) and `anthropic/*`
  keys for the Claude SDK's native tool search (`anthropic/alwaysLoad` on
  eager-tier tools, `anthropic/searchHint` from `AgentTool.searchHint`).
- `names.ts` owns the `pa` server name and external `mcp__pa__*` tool-name
  mapping. It imports nothing, deliberately: `MCP_SERVER_NAME` is read at module
  top level by other modules, so joining the import cycle rooted at
  `agentTypes.ts` would let it be entered half-initialized and throw at startup.
- `agentToolNames.ts` owns `mcpToolNamesFor` — the persona-to-`mcp__pa__*`
  mapping that needs the agent-type registry, split out to keep `names.ts` a
  leaf.
- `sessionToolServer.ts` owns the per-session MCP server: list/call handlers,
  progress notifications, active-set enforcement with a policy-specific denial
  message for stale calls, `tools/list_changed`, and the Claude tool-search list
  metadata (config `eagerToolNames()` → `anthropic/alwaysLoad`; tool
  `searchHint` → `anthropic/searchHint`), so deferred `mcp__pa__*` tools stay
  out of a Claude session's initial context and are discovered on demand by the
  CLI's ToolSearch.
- `toolGroups/` owns the browser tool-group definitions (`browserGroups.ts`:
  `browser` + `browser-raw-mcp`), the proxied external-server connection
  lifecycle, the session artifact side-store, the post-reload continuation
  (`workshop_defer_after_reload`), and per-pack materialized tools
  (`toolsForToolGroup`). It layers one way: `registry.ts` (which groups exist) →
  `browserGroups.ts` (the definitions) → `packRuntime.ts` (what a definition is
  built from: the pack shapes, the shared proxied-call path, artifact capture).
  Both packs are ORDINARY catalog tool groups (`tools/catalog.ts`, via
  `toolsForToolGroup`) — `browser` is always usable and discovered like any
  other deferred tool; `browser-raw-mcp` is gated by the `browserRawMcp`
  integration gate (`browserSettings.ts`, exactly like Jira/Slack/etc.). There
  is no separate per-session enable/approval step, side-store enable state, or
  audit trail.

## Contract notes and rationale

- This folder is harness-neutral: no `@earendil-works/*` or
  `@anthropic-ai/claude-agent-sdk` imports (guarded by `architecture.test.ts`).
  Claude mounts the server via `claudeSdk/toolServer.ts`; pi bypasses it (direct
  adapter in `piSdk/`).
- `ToolSession` is always fully populated by the harness integration; tools must
  not duck-type or default identity.
- Tool `parameters` are plain JSON Schema objects; MCP `inputSchema` is the same
  shape, no conversion.
- Wire contract: tool `details` ride `_meta["pa/details"]` whatever their shape
  and never `structuredContent`; `terminate` and `executionMode` ride `_meta`;
  `ctx.progress` partials are emitted as `notifications/progress` with the
  partial `ToolResult` JSON-encoded in `message` (only when the caller sent a
  `progressToken`).
- Why not `structuredContent` ([Task-439](pa://task/439)): plain-object details
  used to ride there, and that silenced every tool whose payload lives in the
  text while its details are a thin envelope — a `browser_snapshot` reached the
  agent as `{"mcpTool":"browser_snapshot","artifacts":[]}` and nothing else,
  reproduced live, and `ls` lost its listing the same way. The cause is in the
  Claude CLI we run (`claude-agent-sdk` 0.3.219): its MCP result converter, read
  out of the shipped binary, keeps only the NON-text blocks of `content` when a
  `structuredContent` is present and appends that JSON as the text. Treat this
  as observed behaviour of the client we ship against, not as an MCP contract —
  and note the text was never dropped on OUR wire, so a server-side test can
  only assert that no `structuredContent` is emitted.
- Page-state settling ([Task-440](pa://task/440)): the curated actions that
  change what the page shows (`browser_navigate`, `browser_click`,
  `browser_fill`, `browser_press`) do not return Playwright MCP's own page
  state. They re-snapshot until one accessibility tree holds still for
  `SETTLE_STABLE_MS` (750 ms) inside a `PA_BROWSER_SETTLE_MS` budget (8 s, `0`
  disables settling), and return that tree under the ACTION's name. A
  client-rendered app reaches `load` on a placeholder — a navigate to this app
  returned a 54-byte "Connecting…" tree — so the fix is app-agnostic by
  construction, with two guards found by driving the real app: stability is a
  WINDOW, because a 500 ms one still settled on "Connecting…" under load; and a
  tree that is small, has a live region (`status`/`progressbar`/`alert`) and
  offers nothing actionable (no interactive role, heading or landmark) is a
  LOADING SHELL that never counts as settled however still it holds. "Nothing
  actionable" is load-bearing: a `role=alert` beside a form is a validation
  ERROR the agent must read, not a page still coming up. Trees are compared by
  CONTENT: Playwright MCP returns a tree inline for `browser_snapshot` but
  writes a fresh `page-<timestamp>.yml` after an action, and a link read as text
  could never settle, so a linked tree is read back from the artifact dir. The
  settled result is the SNAPSHOT's, because Playwright MCP rebuilds `Page`,
  `Open tabs` and `Modal state` from live tab state on every response, plus the
  action's `Ran Playwright code`, `Result` and `Events` sections carried over —
  `Events` reports downloads and new console entries as a delta since the last
  capture, so dropping it would swallow a download notice. Intermediate trees
  are discarded, so the cost is latency, not context; a page that never holds
  still, or is stuck on a loading indicator, returns the last tree plus a note
  that says which. The settle is best effort: a failed or erroring snapshot poll
  returns the action's own result. `browser_snapshot` stays a RAW read (that is
  how an agent watches a moving page), and `browser_navigate`'s optional
  `waitFor` (`text`, and `timeMs` as a sleep, not a text timeout) maps onto
  `browser_wait_for` for an app slower than the budget — an unmet condition is
  surfaced as the error instead of a settled tree.
- `tools/list` lists only the tools usable right now; a client refreshes its
  list on `tools/list_changed`, and a call to an inactive tool is refused by the
  same active-set check. `_meta["pa/pi"]` now carries `executionMode` alone: pi
  reads the AgentTool directly, and the prompt-extras fields that used to ride
  there are deleted ([Task-282](pa://task/282)). It is kept because
  `executionMode` is not part of the MCP tool surface and an external client
  still needs it to know a tool must not run in parallel.
- Tools throw on failure; the server maps thrown errors to `isError` results.

## Working notes

- Integration-gate changes (including `browserRawMcp`) flow through
  `integrationToolChanges.ts`; `createSessionToolServer` subscribes per session
  and pushes `tools/list_changed` itself (Claude re-lists), and
  `piSdk/toolActivation.ts` subscribes to the same events for pi. Never restart
  sessions or patch harness tool arrays for these changes.
- Keep the artifact side-store shape and the shared
  `SessionArtifact`/`PendingPostReloadContinuation`/`BrowserRuntimeInfo`
  protocol types wire-compatible; coordinate `app/shared` + web when they must
  change.
- Proxied packs spawn external MCP servers via the official SDK
  `StdioClientTransport`; keep the client factory injectable for tests.

## Verification commands

- Run `pnpm --filter @assistant/server test src/mcp` for this subtree's tests.
- Run `pnpm --filter @assistant/server typecheck`.
