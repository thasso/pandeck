<!-- instruction-budget: bytes=4096 reason="Guard credentials, harness boundaries, storage-only views and spawn admission." task=1168 date=2026-10-25 -->

# Server modules

- Validate client messages/untrusted ids before effects. API, WebSocket and MCP
  require token/origin checks. Credentials stay in `DATA_DIR` or env, never
  committed config; drop them on URL origin changes (`urlOrigin.ts`).
- Token-bearing content never executes on the API origin: raw HTML downloads,
  and agent HTML runs only under a typed source/directory grant
  (`directFileGrants.ts`) whose opaque id is its ONLY credential. Never token a
  grant URL, add `allow-same-origin`, trust a client-resolved path, or widen a
  grant past its source directory (`docs/served-files.md`).
- `@earendil-works/*` (not `pi-mcp`) is imported only under `piSdk/`,
  `@anthropic-ai/claude-agent-sdk` only under `claudeSdk/`, and neither under
  `mcp/` or `tools/`. Prompts use `runtimePrompt.ts`, never raw engines
  (`architecture.test.ts`). App code reaches them through `harnesses/`, by
  capability, not harness id. Only `harnessBoundary.test.ts` measurement modules
  are exempt (`docs/agent-harnesses.md`). Drivers supply `nativeFacts()`;
  app-owned `sessionState.ts` builds state. Live engines require its builder at
  construction. Engine projection imports stay at zero in
  `harnessBoundary.test.ts`. Existing-session decisions use `agentHandoffs.ts`.
  Automatic drains wake `deliveryScheduler.ts`.
- Automatic: `accountRouter.ts`; enterprise propagates, never relaxes; host-side
  usage; peer/workflow pins stay exact, unpinned peers route.
  Health/benches/switches require explicit own-subscription runs. Switch after
  native termination, never for Stop or a degraded pick; markers are
  display-only (`docs/account-routing.md`).
- Separate harness/persona axes: branch on shared capabilities, not persona
  keys. Persona creation guards belong in `connection.ts` creation paths.
- Conditional prompt sections/eager tools and library skill names are frozen at
  session START (`promptConditions.ts`/`sessionSkills.ts`), never per turn.
- ALL app tools are harness-neutral `AgentTool`s from `tools/catalog.ts`; never
  add another path. Integration-gate changes reach live sessions as
  `tools/list_changed`, never by restart or tool-array patching.
- Background work enters only through `admitBackgroundWork`; provider hooks and
  tools never write its rows directly.
- Request/watch/list children use `spawnBroker.ts`: server forks stall
  connections. Only warm speech models may spawn directly, once per warm-up, for
  PID lifetime control and SIGKILL escalation unavailable in the broker.
- Git mutations to a WORKING TREE, INDEX, or LOCAL ref use
  `withRepoLock(await checkoutGitOn(side).repoLockKey(cwd), …)`, never a
  checkout key or nested lock. Only network-bound work is lock-free: fetch/push,
  creation submodules, and the remote-ref fetches in `worktreeFetch.ts`,
  `baseCheckoutRefresh.ts` and `pullRequestViewCheckout.ts`; a fetch writing a
  local branch is locked. New exceptions belong HERE with their isolation
  argument; children may not loosen this.
- Checkout git uses `gitExec.ts`; `DATA_DIR` and app-tree repos use
  `serverRepoGit.ts`. `worker/` imports no server state.
- Pull-request provider calls use only `gitHosting.ts`.
- LIST broadcasts are addressed by topic (`hub.broadcastTopic`), each domain
  seam exposing exactly one `broadcast` — never a `broadcastAll`. Per-object
  streams reach only holders. Subscribe is the authoritative SUMMARY read
  (`taskSummaryOf` narrows).
- Views open no harness: `loadSession` answers synchronously from metadata and
  app-owned logs (`viewSession.ts`). Only driving commands may acquire through
  `ensureViewingHarness`; views never await acquisition.
- Session-row writers synchronously report ids and fan-out through
  `db/sessionListChanges.ts` inside any writing transaction. Clock boundaries
  touch before changing projection inputs (`docs/session-list.md`).
- Resolve home only through `userHomeDir()` (`userHome.ts`).
