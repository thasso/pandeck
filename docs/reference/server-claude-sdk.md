# Claude SDK harness — implementation reference

Relocated from `app/server/src/claudeSdk/CLAUDE.md` (Task-274) so it stops
costing agent context on every visit. This is a descriptive snapshot of what the
modules in that subtree own; the rules an agent must not violate stay in that
folder's `CLAUDE.md`. Correct or delete a section here when the code moves on.
Relative paths in the body are relative to the original subtree.

## Purpose

In-process Claude Agent SDK harness for assistant/workshop sessions, including
SDK option construction, stream/message mapping, persistence, and tests.

## Module ownership

- `ClaudeSdkSession.ts` owns SDK stream consumption and exposes runtime adapter
  creation; raw SDK prompting stays private to that class. One closeable input
  queue and one output iterator belong to each process epoch. A `result` closes
  an ordinary epoch but only completes the current PA turn on a retained epoch;
  later prompts use the same queue. The first admitted or observed native
  background task lazily persists retention, and the process closes after the
  last task plus its frozen quiet grace. Prompt attachments are supported
  (`capabilities.attachments` is true): the private prompt persists + threads
  them via the shared `../promptAttachments.ts` builder, streaming a one-turn
  user message whose content carries image content blocks plus the text prompt
  (non-image files referenced/inlined through the suffix).
- `toolServer.ts` owns mounting the generic session tool server
  (`mcp/sessionToolServer.ts`) for a session: ToolSession context synthesis,
  persona toolset, active-set filtering (tool-group list_changed is wired inside
  the generic server), and the eager-tier names (`eagerToolNamesFor`) so the
  SDK's native tool search (enabled via `options.ts`'s `ToolSearch` allowlist
  entry) keeps the catalog's eager tools in context and defers the rest
  (verified live: deferred-tool context cost drops from ~27.5k to ~7.9k cached
  tokens for the full assistant catalog on haiku; `getContextUsage()` isLoaded
  flags and on-demand loading both confirmed).
- `ClaudeSdkSession.compactContext` owns manual compaction (`/compact` via
  `../hostSlashCommands.ts`). The CLI owns this session's context, so compaction
  is driven by sending the LITERAL `/compact [instructions]` text as the turn's
  user message: the CLI handles it locally (no model turn; verified live),
  rewrites the resumed session file and reports a `system`/`compact_boundary`
  (`messageMapper.compactBoundaryMetadata`: trigger, pre/post tokens, preserved
  uuids). The summary text is NOT in that message — it arrives only through a
  `PostCompact` hook registered on that one query. The boundary is the ONLY
  success signal: without one, the run is a `skipped` outcome carrying the CLI's
  own answer (`result.result`, e.g. "Not enough messages to compact.", reported
  with `is_error: false`). A retained epoch sends `/compact` through its
  existing input queue and filters replay messages in-band, so no second process
  shares its provider session id. Without a retained epoch, the explicit no-tool
  option suppresses native tools, `Skill`, `ToolSearch`, and frozen-library
  plugins; compaction carries the frozen names for continuity but neither
  materializes nor discovers skills. That stream is deliberately NOT fed through
  `handleSdkMessage`: after the boundary the CLI REPLAYS the preserved messages
  as ordinary user/assistant messages, which would be appended to the transcript
  a second time — only the boundary, captured session id and `result` usage are
  taken from it. A dedicated transient compaction query mounts no native tools
  or MCP server; the retained path keeps the existing process but admits no
  model tool turn.
- A `compact_boundary` arriving on an ORDINARY turn's stream is the CLI's own
  automatic (threshold) compaction: `handleAutoCompaction` corrects the context
  reading from `post_tokens`, notices the viewer, and resets the memory session
  context (+ flushes pending observations) — the same consequence the pi harness
  draws from `compaction_end`. Claude's automatic compaction is otherwise
  invisible to us; there is no durable card for it.
- A denied provider-initiated turn arms the foreign-result gate: PA owes one
  `result` it must not attribute to anyone, so until that debt clears every
  message is discarded (background lifecycle events and `compact_boundary` still
  reconcile) and `/compact` is refused with "Claude is still settling an
  interrupted background turn; compact after it finishes." Ownership is NEVER
  inferred from arrival order — that mis-attributed a foreign turn's trailing
  text and cost to a user's prompt. The gate clears on the next `result`
  observed on that stream, whichever turn it belongs to, so the worst case is
  one sacrificed prompted turn, not a stuck session.
- Host-driven turns set `syntheticTurn` and leave rendered teardown to their
  `finishSynthetic*` path (`finishSyntheticTool`, `finishSyntheticCard`). Stop
  uses `interrupt()` when a retained process must survive and `close()` only for
  process teardown; both paths are idempotent.
- `backgroundWorkBackend.ts` implements the `claude-query` backend port with
  owner/epoch-local maps. `PreToolUse` reserves background Bash and every
  Monitor call through `admitBackgroundWork` by `tool_use_id`, reading the
  `command` (or the Monitor's `ws.url`) and `description` off the tool input so
  the row can say what the job is — the provider's task events only ever repeat
  the description; authoritative denial uses `permissionDecision: "deny"`, never
  `continue:false`. A Stop-hook snapshot that terminalizes a row records "Claude
  reported the task as <status>" as its outcome, never the task's description:
  what a job IS is not how it ended. It binds on `task_started`, treats
  `background_tasks_changed` as level-only evidence, and uses the Stop-hook
  snapshot for recovery. Provider-started turns enter through
  `beginRuntimeProviderTurn`, after peer FIFO and before accepting transcript or
  tool events. Each child gets a PA-created 0700 `TMPDIR`; the per-epoch trusted
  output root is its private `claude-${uid}` directory. Both `TMPDIR` and
  `CLAUDE_CODE_TMPDIR` are set because the latter takes precedence in the CLI.
  Task notifications capture `output_file` only beneath that root. The
  descriptor is opened with no-follow checks, validated as owned regular UTF-8
  text, sanitized, and capped at 64 KiB. Linux `/proc/self/fd` identity checks
  are required by this deployment, so other platforms refuse identity
  verification. The 64 MiB scan ceiling bounds the synchronous stall but does
  not make a full scan cheap, especially on cold or network-backed storage. The
  item stores artifact identity and size/refusal metadata, never the vendor path
  or captured text in its projection, and the content is never injected into a
  prompt. A timer failure for a provider turn also leaves a bounded assistant
  error entry in the durable timeline.
- `messageMapper.ts` and `streamMapper.ts` own SDK-to-display/runtime block
  mapping.
- `modelSettings.ts` owns the persona-free half: the harness-wide settings
  applied to every run, the curated model list with its alias normalization, and
  the thinking-level mapping. Helper runs (`oneShot.ts`, through `runOneShot`)
  are reached from tool modules by contract, so they take this module and never
  `options.ts`, which reads the persona registry and through it the whole tool
  catalog.
- `options.ts` owns persona system-prompt application, query option
  construction, frozen-library local-plugin qualification, and the first-line
  native output environment caps. A non-empty frozen list adds one local plugin
  with `skipMcpDiscovery: true` only for `developer`/`workshop`; the SDK
  `skills` filter stays omitted and coding `settingSources` stays at CLI
  defaults so repository `.claude/skills` remain discoverable.
  `skillInjection.ts` rescans and materializes the frozen set before every
  ordinary first/resumed/fork query; empty and assistant-persona sets do no
  storage work. `outputPolicyHooks.ts` installs query-local `PreToolUse` /
  `PostToolUse` hooks: unranged reads receive a bounded default window, Claude's
  structured `FileReadOutput.file` line metadata drives exact continuation
  notices, and large successful native results are reduced by the shared
  `../outputPolicy.ts` contract before entering Claude history while preserving
  the tool's output schema. Their raw payload is retained as a session artifact.
  Native failures instead use `PostToolUseFailure`: the SDK cannot replace that
  output, so the CLI environment cap bounds it and the hook adds targeted
  command/conflict context. Option construction also includes `canUseTool`
  gating for native tools and the mounted `mcp__pa__*` namespace. `ToolSearch`
  (the CLI's own deferred-tool search) is added to the `tools:` ALLOWLIST ARRAY
  itself for every persona — the CLI's `isToolSearchToolAvailable` gate requires
  that; coding personas likewise receive `Skill`, whose literal `tools:`
  membership is required for the model to invoke the context-injecting tool.
  (`Skill` remains available in Plan because loading skill context is
  non-mutating.) canUseTool alone does nothing for either CLI-gated tool: it is
  shadowed entirely by `bypassPermissions`, verified live — omitting
  `ToolSearch` from `tools:` silently loads every `mcp__pa__*` definition
  upfront regardless of `alwaysLoad`, for every persona and model. The
  host-owned persona/tool allowlist is authoritative: interactive coding
  sessions use `bypassPermissions` so ordinary allowed Bash commands run without
  per-command prompts (like pi), while assistant personas still receive no
  native shell/file tools. LIMIT: bypass does NOT cover the bundled Claude Code
  CLI's git-safety gate, which denies `git push` (and out-of-cwd file deletes)
  before `canUseTool` is consulted and cannot be overridden by any SDK option;
  pushing is therefore app-side via `../pushWorkflow.ts`: agents use checked
  `worktree_push`, while `/push` remains the human free-form host command.
  Managed-worktree commits similarly use `worktree_commit`, with `/commit` as
  the human surface. Do not add bare `allowedTools` entries that shadow the
  callback. `CLAUDE_SDK_NATIVE_TOOLS` is the coding personas' native set —
  `Read`/`Write`/`Edit`/`Bash`/`Monitor` plus `Grep`/`Glob` since
  [Task-316](pa://task/316); everything else in `KNOWN_CLAUDE_NATIVE_TOOLS`
  (`MultiEdit`, `WebFetch`/`WebSearch`, the `Todo*` pair, the notebook pair) is
  filtered into `disallowedTools`. The search pair is on because the alternative
  is a `Bash` round trip per search with unbounded output; the todo pair stays
  off deliberately (`../tasks.md`), and web fetch/search stay off because our
  own `web_fetch`/`web_search` supersede them. There is no native listing tool
  to turn on — `Glob "*"` returns files recursively and never directory entries
  — so [Task-319](pa://task/319) closed that asymmetry with the app-side `ls`
  (`tools/core/lsTool.ts`), eager for both harnesses, rather than leaving Claude
  on `Bash ls`. These definitions ship INSIDE the CLI (extracted from bunfs at
  runtime, absent from the SDK package), so their wire cost is not measurable
  in-process: the inventory's `tools:eager:harness-builtin` row is uncounted for
  Claude, the same convention `harness-base (0)` uses for the `claude_code`
  preset — pi's two search builtins cost 1,612 chars for comparison (1,509 of it
  definition text, the rest their prompt snippets).
- `options.ts` also owns the `SessionMode` (Build/Plan) tool policy
  ([Task-329](pa://task/329)), a second axis independent of the persona.
  `buildClaudeSdkQueryOptions` takes a getter for the session's LIVE mode and
  never lets it shape `tools:`/`disallowedTools`: those are fixed when the
  Claude process starts, and a process retained for background work must be able
  to leave Plan without a restart that would kill that work
  ([Task-756](pa://task/756)). Instead the `PreToolUse` hook refuses the
  file-mutating natives (`CLAUDE_NATIVE_MUTATING_TOOLS`: `Write`, `Edit`,
  `MultiEdit`, `NotebookEdit`) per call while the mode reads Plan, so a switch
  in either direction reaches the running process on its next tool call. The
  builder therefore refuses a mode without `outputPolicySessionId`, whose hooks
  carry the gate. `canUseTool` reads the same live mode so it stays consistent
  even though `bypassPermissions` shadows it entirely. The mounted MCP server
  also filters catalog tools whose `sideEffects` are `local` or `external`,
  except `task_manage` for durable Task organization and `session_spawn` for
  read-only profile inspection; that tool still refuses `spawn`/`propose`
  against persisted Plan mode. `canUseTool` independently denies the remaining
  blocked external `mcp__pa__*` names for stale or forged calls. `Read`, `Bash`,
  `Grep`/`Glob`, `ToolSearch`, `Skill` for coding personas, read-only app tools,
  and Task management remain, so a planning session investigates and records
  plans at full strength. Both modes start an identical process. A frozen
  library plugin remains mounted in Plan, matching the retained `Skill`
  invocation surface. Deliberately NOT the SDK's own `permissionMode: "plan"`
  (`sdk.d.ts:1736`): that halts tool execution generally, imposes the CLI's
  `EnterPlanMode`/`ExitPlanMode` protocol and can emit `conversation_reset` on
  exit — the opposite of "all tools allowed, no file mutation".
  `planModeInstructions` is likewise never set and
  `allowDangerouslySkipPermissions` is untouched. `ClaudeSdkSession.setMode`
  persists immediately. A retained epoch switches in either direction through
  the live `PreToolUse` gate, without restarting or stopping its background
  work. Retained model/thinking edits use SDK controls instead of another query.
  On acquire the RECORD's mode wins over the caller's, so reopening resumes the
  mode the session was left in and a stale client cannot silently re-enable
  writes. Its `state()` projection reads the insert-only frozen skill row into
  `activeSkills` for coding personas; rendering never resolves live settings.
- `claudeSdkRecords.ts` owns the on-disk record format (metadata beside an
  append-only timeline log, legacy single-file read, crash-safe writes); see
  `docs/claude-session-records.md`.
- `claudeSdkStore.ts` owns persisted Claude SDK session records, including
  `ClaudeSdkRecord.mode` — the one field of the record that legitimately moves
  during a session's life rather than being fixed at creation. `acquire` claims
  the session's `SessionScope` and syncs the metadata row BEFORE the session
  enters the live map ([Task-492](pa://task/492)): the session list treats a
  live session with no row as the user's, so the classification may never lag
  the registration.
- `claudeSdkStore.forkSession` freezes a legacy parent's skills before the cut
  and writes the exact inherited list on the child, so settings cannot move a
  branch. It otherwise owns branching, cutting THREE things to the same point in
  this order: the native transcript (the SDK's inclusive `upToMessageId`, via
  `sdkSeam`), the app-owned runtime log (`SessionRuntime.forkLog`), and the
  session record. The native cut happens FIRST, so a transcript the provider can
  no longer read fails before any session exists. The runtime log is
  AUTHORITATIVE — it is what the transport renders and what later anchors are
  read from — so `keepThroughEntryId` is a runtime log entry id (the only id a
  client holds) and the record's entries are DERIVED from the forked log rather
  than sliced separately; the two id spaces are different and slicing the record
  by a runtime id silently matches nothing. Seeding the child's log is what
  stops it opening on an empty transcript beside a populated provider session.
  The copied prefix is deliberately UNANCHORED, because `forkSession` remaps
  every uuid it copies: the child re-anchors through its own turns, and its
  inherited prefix offers no fork point until then. ORDER matters both ways: OUR
  cut is validated first (`SessionRuntime.canForkLogAt`) because the provider's
  is not undoable, and a failure after it is compensated with `deleteSession` —
  a native transcript no session references would otherwise outlive the app's
  own retention. The child keeps the parent's title but stays
  `forkAutoRenamePending`, so its first prompt names it instead of leaving two
  identically-titled rows. The child is a new session id inheriting the
  EFFECTIVE cwd (worktree edge first, as `acquire` resolves it — a session
  linked after creation has a stale cwd on both its record and its live
  instance), model, thinking level, mode, persona, credential profile and
  system-prompt suffix, and records `forkOrigin`. It inherits the parent's
  `SessionScope` too, claimed before the child enters the live map: forking is
  not a way for a session outside the user's scope to produce one inside it.
- `sdkSeam.ts` owns the seam between production SDK calls and tests. The query
  handle optionally exposes `getContextUsage()` (fakes omit it); after every
  `result` message `ClaudeSdkSession` refreshes which `mcp__pa__*` definitions
  the CLI's tool search has loaded (best-effort, awaited before the single-turn
  process exits) and serves `SessionState.toolExposure` from the catalog + that
  cached load state (eager tier assumed loaded before the first refresh). It
  also optionally exposes
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`, typed as a
  loose `Record<string, unknown>` since the SDK marks the response shape
  unstable and the observed runtime payload already exceeds the package's own
  declared type.
- `usageQuery.ts` owns the Usage page's Claude account fetch
  (`fetchClaudeSdkUsage`, backing `GET /api/usage/claude`): when a profile id is
  provided it uses that same scrubbed isolated profile environment, so account
  usage never falls back to an ambient login. It uses a throwaway query whose
  prompt is a streaming generator that never yields, so the CLI subprocess
  starts and can answer the control request without ever running a model turn
  (no tokens spent). `mapClaudeUsageResponse` defensively projects the
  loosely-typed raw response into the stable `@assistant/shared/usage`
  `ClaudeUsageSnapshot` shape. Test-seam override mirrors `oneShot.ts`'s pattern
  (`setClaudeSdkUsageSeam`).
- `oneShot.ts` owns the Claude engine half of headless helper queries, reached
  only through `runOneShot` (`harnesses/oneShot.ts`). An error result is
  reported as `failure`, not thrown. Native tools and inherited settings are
  always disabled; callers may optionally mount an explicit app-tool allowlist
  over the in-process MCP server with bounded model turns. A caller may also
  pass `documents` (e.g. a base64 PDF); the run then streams one user turn
  carrying those content blocks plus the text prompt.
- Claude's native "auto-memory" is disabled GLOBALLY for every `claude-sdk`
  session — interactive (`options.ts`) and one-shot (`oneShot.ts`) — via the
  single `CLAUDE_SDK_HARNESS_SETTINGS` flag-layer `settings` object
  (`autoMemoryEnabled: false`, `autoDreamEnabled: false`) exported from
  `options.ts`. Our in-app first-class Memory (`memory_*` tools) is the sole
  authoritative memory surface; do not re-enable the SDK's separate on-disk
  `~/.claude/.../memory` store. The persona system prompts already teach the
  in-app Memory system (`memoryPrompt.ts`, injected by `agents.ts`).
- The same settings object pins `cleanupPeriodDays` far past the CLI default of
  30 days. The native `.jsonl` under `CLAUDE_CONFIG_DIR` is the only thing a
  fork can be cut from, so the vendor sweep would silently expire forkability
  for every session older than a month. Retention of PA session data is PA's
  decision — which makes PA responsible for the removal: `claudeSdkStore.remove`
  deletes the native transcript alongside the record (best-effort, like the rest
  of that path). Pinning retention without wiring deletion would orphan every
  deleted session's transcript for a decade.
- Session MUTATIONS (`forkSession`, `deleteSession`) run IN this process and
  resolve the local config root from OUR environment, unlike queries, which pass
  `claudeProfileEnvironment`'s `CLAUDE_CONFIG_DIR` to the subprocess. Their
  `dir` option only selects the project key inside a root. So every mutation
  passes a `sessionStore` from `profileSessionStore.ts`, bound to the session's
  own credential profile; without it a named profile's sessions are invisible
  ("Session not found"). Flipping `process.env.CLAUDE_CONFIG_DIR` around the
  call is NOT an alternative: profiles run concurrently and a global flip races
  every other in-flight call.

## Contract notes and rationale

- Claude account profiles are provisioned by the official Claude CLI, never by
  hidden Agent SDK OAuth controls. The protected Default Claude profile reflects
  the service user's normal `~/.claude/.credentials.json`, runs without a
  `CLAUDE_CONFIG_DIR` override, and intentionally applies to PR previews too
  because they run as the same service user. Named profiles get a private
  `CLAUDE_CONFIG_DIR` under `DATA_DIR/credential-profiles/<id>/claude`. Settings
  may wrap `claude auth login --claudeai` in the dedicated authenticated browser
  terminal (`../claudeLoginTerminal.ts`) or show the direct shell command as
  fallback; PA may stream bounded CLI output and forward an unlogged
  authorization code to stdin, but must never own the OAuth exchange, call
  undocumented SDK auth controls, or expose profile credentials to the browser.
  A selected profile id persists in record/session metadata;
  `claudeProfileEnvironment` always scrubs inherited Anthropic/Claude credential
  variables before choosing ordinary or isolated config resolution.
- Do not double-count streamed text/thinking: live deltas build visible text;
  committed assistant messages provide metadata/tool openings.
- Preserve prompt idempotency using client request IDs where supported.
- Drive sessions through the normalized runtime prompt facade/adapter; do not
  add public raw prompt methods.
- Keep SDK sessions fixed to their initial persona/toolset (`assistant`,
  `personal-assistant`, `workshop`, or `developer`). The assistant personas
  (`assistant` and the singleton `personal-assistant`) get the locked-down
  prompt and no native file/shell tools; the coding personas build on the Claude
  Code preset. A session may persist an additional system-prompt suffix. Apply
  it after the persona prompt once when each fresh or resumed process epoch is
  created; later turns on a retained query reuse that frozen prompt.
- Persist normalized timeline entries plus provider session, model, title, and
  usage data to survive dev reloads. `claudeCommitContext.ts` reconstructs
  `worktree_commit` checkpoints from those durable tool results. The commit
  manager is constructed ONCE with the per-session MCP server (not by its
  per-call `session()` projection), so it can hold a successful checkpoint for
  another tool round in the same turn, dropping that pending copy once the
  matching commit hash appears in the timeline. Runtime model reconciliation
  accepts only recognized curated Claude model ids: provider error messages may
  report sentinels such as `<synthetic>`, and unknown/synthetic ids must never
  flow through the configuration fallback or mutate the persisted selection.
- Turn-completion usage (adapter `messageCompleted` and the committed assistant
  entry) is the run's delta: `cumulative` sampled at turn open
  (`turnStartTotals`) diffed via `perTurnUsage`, with `contextTokens` from the
  per-request snapshot. Only the persisted record/`contextInfo` carry
  session-cumulative totals.
- Session-cumulative token totals accumulate each `result`'s TRUE per-run
  aggregate summed from `modelUsage` (`mapResultRunUsage`) — the tokens billed
  across EVERY internal tool-loop request AND every model that ran (main +
  helper/background/subagent). Never accumulate the top-level `result.usage`: it
  is only the final request's per-message snapshot (the same shape
  `assistantUsage` reads for live context size), so summing it undercounts. Fall
  back to top-level `usage` only when `modelUsage` is absent/empty.
  `usage.input` is the provider's UNCACHED remainder, not total input: with
  prompt caching it is a near-zero residual (a long session can total ~165
  against millions of cache reads), so any total-input figure must add
  `cacheRead` + `cacheWrite`.
- A restored session must rehydrate `updatedAt` (`claudeSdkStore.acquire` passes
  `record.updatedAt`, the constructor falls back to `createdAt` only for a
  genuinely new session). Dropping it back-dates the session to its creation
  time on every restart until its next mutation, which corrupts session-list
  ordering, the `updatedAt > readAt` unread check, and both metadata rows
  written from the record.
- `syncRegistryRecord`'s metadata-equality guard skips only the `session_index`
  upsert; the `session_usage_totals` mirror always runs after it (usage can move
  while every compared metadata field is identical), and its `usageTurns` is the
  count of assistant entries that actually reported usage — never a hardcoded
  value.
- Per-session cwd: the `in_worktree` edge is the durable source of truth
  (`worktrees/sessionCwd.ts`), the persisted record `cwd` is the fallback; the
  session's cwd feeds query options, the tool session, and the commit workflow
  context.
- Aborts must emit `assistantEnd` with `aborted: true` and retain partial
  assistant/tool evidence rather than treating the turn as success or erasing
  it.

## Working notes

- Treat mapper changes as protocol-sensitive; verify both display and normalized
  runtime consumers.
- Keep the mounted session tool server's toolset and query `systemPrompt`
  compatible with the selected persona; tool-group changes reach the session via
  tools/list_changed, never a session restart.

## Verification commands

- Run `pnpm --filter @assistant/server test` for Claude SDK harness tests.
- Run `pnpm --filter @assistant/server typecheck` for this subtree.
- Run root `pnpm run build` before closeout.
