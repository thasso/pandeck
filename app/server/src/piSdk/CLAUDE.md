# pi SDK harness

- Hub behaviour arrives via `piStore.setHost`, never a static `hub.ts` import.
- Pi tools use the `toolActivation.ts` adapter: app tools execute via
  `appTools.call`, the rest in place; the session MCP server serves Claude and
  external consumers only. Register the full tool universe up front (pi cannot
  add definitions later). Every active-set change uses `applyActiveToolNames` →
  `setActiveToolsByName`, with additive activations inside a tool's execute
  window. Plan removes catalog tools with local/external side effects except
  `task_manage` (deliberate); the execute gate also denies stale calls.
- Native-tool personas register provider-native `bash`/`monitor` shadows up
  front, unless its frozen agent definition denies `bash` (pi's Claude
  native-tool hooks, not a second catalog path). Foreground Bash delegates
  upstream; background work retains frozen `PI_*` identity but no `AgentSession`
  or live-session reference.
- Coding resource loaders use only the session's frozen skill names,
  rematerialized before every reload; assistant personas keep `noSkills: true`,
  no library path.
- Outside `piSdk/` and in `PiLiveSession`, reach a live engine only via
  `PiEngineHandle`: synchronous reads, promise commands the reporting consumer
  awaits before reading their effect. In-loop policy is engine-side;
  `nativePiSessionForTests` is test-only.
- Failover stages a registry/runtime on the same file/id; tools swap after
  admission. SDK `display: false` custom turns retain settlement, retry,
  compaction and queues; `Agent.continue` does not. Context edits retain
  physical history.
- Session-open/canonicalize paths encode pi footguns (empty-header id minting,
  pending-output retargeting); keep `sessionResolver.test.ts` green.
- A session's cwd is its `in_worktree` edge, else the record `cwd`, threaded
  through `buildAgentOptions`, `SessionManager.create/open`,
  `createAgentSession` and the tool session, never a hardcoded `CWD`. Reopen
  order: edge → file header → app CWD.
