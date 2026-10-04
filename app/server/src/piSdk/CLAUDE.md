# pi SDK harness

- No static import of `hub.ts` anywhere here — hub behaviour arrives via
  `piStore.setHost(...)`/`HarnessHost` injection.
- Pi tools always come from the direct adapter over `toolActivation.ts` (the
  session MCP server serves Claude and external consumers only). The full tool
  universe registers up front — pi cannot add DEFINITIONS mid-session — and
  every active-set change flows through `applyActiveToolNames` →
  `setActiveToolsByName`, with additive activations inside a tool's execute
  window. Plan removes catalog tools with local/external side effects except
  `task_manage`, the deliberate durable-Task exception; the execute adapter
  independently denies stale calls.
- Coding sessions register provider-native `bash`/`monitor` shadows up front.
  This is pi's equivalent of Claude native-tool hooks, not a second catalog
  path. Foreground Bash delegates upstream; background work retains frozen
  `PI_*` identity but no `AgentSession` or live-session reference.
- Coding resource loaders consume only the session's frozen skill names and
  rematerialize that same set before every reload; assistant personas keep
  `noSkills: true` and receive no library path.
- Session-open/canonicalize paths encode pi SDK footguns (id minting on empty
  headers, pending-output retargeting): change them only with
  `sessionResolver.test.ts` green.
- A session's cwd is its `in_worktree` edge, with the persisted record `cwd` as
  fallback, and must be threaded through `buildAgentOptions`,
  `SessionManager.create/open`, `createAgentSession` and the tool session —
  never a hardcoded `CWD` in one of them. Reopen precedence: edge cwd → the
  session file's own header cwd → app CWD.
