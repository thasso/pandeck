<!-- instruction-budget: bytes=4000 reason="Contracts guard shipped defects and migrations. The credential rule pins tokens to their URL origin. The newest closes the harness boundary to all but the measurement modules. Two older ones: the view rule (opening a session parsed its provider transcript first — 1.7s on one 51 MB pi file) and the spawn rule (every git process forked this 1.3 GB server, freezing all connections); one careless await or spawn brings either back." task=agent-harnesses date=2026-10-04 -->

# Server modules

- Validate client messages and untrusted ids before effects. Keep API,
  WebSocket, and MCP behind token/origin checks; credentials stay under
  `DATA_DIR` or in the environment, never committed config. A stored credential
  is dropped when its URL moves to another origin (`urlOrigin.ts`).
- Token-bearing content never executes on the API origin: raw HTML downloads,
  and agent HTML runs only under a typed source/directory grant
  (`directFileGrants.ts`) whose opaque id is its ONLY credential. Never token a
  grant URL, add `allow-same-origin`, trust a client-resolved path, or widen a
  grant past its source directory (`docs/served-files.md`).
- `@earendil-works/*` (not `pi-mcp`) is imported only under `piSdk/`,
  `@anthropic-ai/claude-agent-sdk` only under `claudeSdk/`, and neither under
  `mcp/` or `tools/`. Prompts use `runtimePrompt.ts`, never raw engines
  (`architecture.test.ts`). App code reaches those folders only through
  `harnesses/`, branching on capabilities, not harness ids. Only
  `harnessBoundary.test.ts`'s measurement modules are exempt
  (`docs/agent-harnesses.md`). Existing-session decisions (cards, questions,
  handoffs) use `agentHandoffs.ts` for mid-turn queueing.
- Automatic: `accountRouter.ts`; enterprise propagates, never relaxes; host-side
  usage; explicit peer/workflow pins. Health/benches/switches require explicit
  own-subscription runs. Switch after native termination, never for Stop or a
  degraded pick; markers are display-only (`docs/account-routing.md`).
- Separate harness/persona axes: branch on shared capabilities, not persona
  keys. Persona creation guards belong in `connection.ts` creation paths.
- Conditional prompt sections/eager tools and library skill names are frozen at
  session START (`promptConditions.ts`/`sessionSkills.ts`), never per turn.
- ALL app tools are harness-neutral `AgentTool`s from `tools/catalog.ts`; never
  add another path. Integration-gate changes reach live sessions as
  `tools/list_changed`, never by restart or tool-array patching.
- Background work enters only through `admitBackgroundWork`; provider hooks and
  tools never write its rows directly.
- Request/watch/list children start via `spawnBroker.ts` (`gitExec.ts` uses it),
  never by forking this server: its page tables stall every connection.
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
