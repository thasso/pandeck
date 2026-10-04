<!-- instruction-budget: bytes=3904 reason="Thirteen dense contracts, each guarding a shipped defect or a migration in flight. The newest pins the harness boundary so no new engine reach slips past the agent-harness migration. Two older ones: the view rule (opening a session parsed its provider transcript first — 1.7s on one 51 MB pi file) and the spawn rule (every git process forked this 1.3 GB server, freezing all connections); one careless await or spawn brings either back." task=agent-harnesses date=2026-10-04 -->

# Server modules

- Validate client messages and untrusted ids before effects. Keep API,
  WebSocket, and MCP behind token/origin checks; credentials stay under
  `DATA_DIR` or in the environment, never committed config.
- Token-bearing content never executes on the API origin: raw HTML downloads,
  and agent HTML runs only under a typed source/directory grant
  (`directFileGrants.ts`) whose opaque id is its ONLY credential. Never token a
  grant URL, add `allow-same-origin`, trust a client-resolved path, or widen a
  grant past its source directory (`docs/served-files.md`).
- `@earendil-works/*` is imported only under `piSdk/`,
  `@anthropic-ai/claude-agent-sdk` only under `claudeSdk/`, and neither under
  `mcp/` or `tools/`. App-level prompts go through `runtimePrompt.ts`, not a raw
  engine call. `architecture.test.ts` guards both. No new import of `piSdk/` or
  `claudeSdk/` and no new harness-id comparison elsewhere (`harnesses/` and
  `test/` aside): `harnessBoundary.test.ts` pins the rest, which only shrink
  (`docs/agent-harnesses.md`). A user decision handed to an EXISTING session
  (card outcome, question answer, review handoff) goes through
  `agentHandoffs.ts`, which queues it when that session is mid-turn instead of
  losing it.
- Harness and persona are separate axes: branch on the shared capability
  predicates, never on a persona key, and keep persona creation guards in the
  `connection.ts` creation paths, not at call sites.
- Conditional prompt sections/eager tools and library skill names are frozen at
  session START (`promptConditions.ts`/`sessionSkills.ts`), never per turn.
- ALL app tools are harness-neutral `AgentTool`s from `tools/catalog.ts`; never
  add another path. Integration-gate changes reach live sessions as
  `tools/list_changed`, never by restart or tool-array patching.
- Background work enters only through `admitBackgroundWork`; provider hooks and
  tools never write its rows directly.
- The server never forks itself for per-request work: child processes on
  request, watch and list paths start through `spawnBroker.ts` (`gitExec.ts`
  does). Each fork copies this process's page tables and stalls every
  connection.
- Git mutations to a WORKING TREE, INDEX, or LOCAL ref use
  `withRepoLock(await repoLockKey(cwd), …)` from `gitExec.ts`, never a checkout
  key or nested lock. Only network-bound work is lock-free: fetch/push, creation
  submodules, and the remote-ref fetches in `worktreeFetch.ts`,
  `baseCheckoutRefresh.ts` and `pullRequestViewCheckout.ts`; a fetch writing a
  local branch is locked. New exceptions belong HERE with their isolation
  argument; children may not loosen this.
- Pull-request provider calls use only `gitHosting.ts`.
- LIST broadcasts are addressed by topic (`hub.broadcastTopic`), each domain
  seam exposing exactly one `broadcast` — never a `broadcastAll`. Per-object
  streams reach only connections holding that object. Subscribing is also the
  authoritative read, and those items are SUMMARIES (`taskSummaryOf` is the one
  narrowing).
- SHOWING a session opens no harness: `loadSession` answers synchronously from
  the metadata row and the app-owned log (`viewSession.ts`). Only a command that
  DRIVES it may acquire one, through `ensureViewingHarness`; never await an
  acquisition on a view path.
