# pi SDK harness — implementation reference

Relocated from `app/server/src/piSdk/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

In-process pi harness for assistant/workshop sessions, mirroring `claudeSdk/`:
session lifecycle, event mapping, option/resource-loader construction,
model/auth registry, the direct AgentTool adapter with deferred tool activation,
and headless one-shot utility runs.

## Module ownership

- `PiLiveSession.ts` owns the pi session class: pi stream consumption, synthetic
  tool turns, accept-mutation flows, runtime-adapter creation (raw prompting
  stays private), tool-group binding, idle eviction. Slash-command dispatch is
  NOT here: every host-driven command runs through `../hostSlashCommands.ts`
  against the shared `SyntheticToolHost` surface, to which this class
  contributes `compactContext` (pi's `AgentSession.compact`, which never
  declines) and the `finishSynthetic*` renderers. It talks to the hub only
  through the injected `PiSessionHost`. Prompt attachments are persisted +
  turned into model content through the shared `promptAttachments.ts` builder
  (images as content blocks; other files persisted to `sessionAttachments` and
  referenced/inlined via the prompt suffix).
- `piStore.ts` owns the live-session registry: acquire/open/fork/create/track,
  eviction (runtime dispose stays adjacent to map removal), rename, image
  resolution, list aggregation, and per-session tool activation
  construction/teardown. Fresh sessions without an explicit binding select the
  first enabled OpenAI profile, so automatic/background pi work does not
  silently use a disabled protected default. Forks immediately persist the
  parent's immutable credential-profile binding on the child so cold reopen
  selects the same runtime. Interactive pi sessions also carry their mutable
  Build/Plan mode here: creation prefers the persisted `session_index.mode` over
  a requested start value, and a live flip re-applies the active-set merge.
  Every create/open calls `sessionSkills`; a fork freezes a legacy parent first
  and passes its exact list to the child. `PiLiveSession.state()` reads the
  frozen row into `activeSkills` for coding personas without creating one.
  `track` claims the session's `SessionScope` ([Task-492](pa://task/492)) before
  the live map can hand it to the session list, so a session that is not the
  user's is persisted as such before anything can observe it; a caller creating
  one declares it on `acquireNew` rather than upserting the scope afterwards, a
  fork inherits its parent's scope, and a claim that contradicts the stored
  scope throws instead of registering.
- `options.ts` owns pi session options: resource loaders per persona, the
  always-loaded hidden `outputPolicyExtension.ts` inline extension, the manager
  sub-variant, tool policy (`agentTools` from the persona registry plus the
  catalog's `eagerToolNames`/`deferToolLoading`; assistant personas use
  `noTools: "builtin"`, NEVER a `tools:` allowlist — pi force-re-activates every
  allowlisted tool on registry refresh, defeating the deferred active set), and
  session store directories. `extraBuiltinToolNames` carries the pi BUILTINS a
  persona wants active beyond pi's default `read`/`bash`/`edit`/`write`: the
  coding personas take `PI_SEARCH_BUILTIN_TOOLS` (`grep`/`find`), which pi
  registers as definitions but leaves inactive ([Task-316](pa://task/316)); the
  assistant personas take none. For `developer`/`workshop`, the builder also
  receives the session's insert-only frozen skill-name list and gives pi the
  materialized `<hash>/skills` root through `additionalSkillPaths`. Its loader
  re-scans and re-materializes that SAME list before every resource reload, so
  cache cleanup cannot make a resumed live session silently lose skills;
  missing/invalid frozen names fail loudly. Empty coding sets use the
  deterministic empty-set path, while assistant personas retain `noSkills: true`
  and never receive a library path. pi loads profile and repository skills
  first: same-realpath aliases dedupe silently, and a distinct same-name
  `.pi/skills` entry wins with pi's `collision` diagnostic. pi's `ls` builtin is
  deliberately NOT listed: [Task-319](pa://task/319) replaced it with the
  app-side `ls` tool (`tools/core/lsTool.ts`, eager on both harnesses), which
  SHADOWS it rather than colliding with it — `_refreshToolRegistry` builds
  `definitionRegistry`/`_toolRegistry` as Maps keyed by tool NAME, inserting
  builtins first and then `set()`-ing every custom tool over them, and our app
  tools arrive as `customTools`. So the name can never appear twice, and keeping
  `"ls"` listed would have been dead config that still made the prompt inventory
  price and describe a builtin the model never receives. The ordering is pi's,
  not ours: an app-side `ls` that ever stopped being a `customTools` entry would
  flip which definition wins. `piStore` unions the list into the built-in half
  of the active-set merge — the reason a `tools:` allowlist is off-limits
  applies here too. Both bound their own output by default (grep: 100 matches /
  50KB / 500 chars per line; find: 1000 results / 50KB), and
  `createAgentSession` exposes no hook for their `*ToolOptions`, so those
  defaults are what a session gets before the inline output policy applies its
  lower provider-history ceiling. The extension adds bounded default read
  windows, concise quality-gate success summaries, diagnostic failure tails,
  targeted diff/conflict guidance, and session artifacts for every elided raw
  result through the shared `../outputPolicy.ts` policy. `grep` and `find`
  respect `.gitignore`, unlike the `bash` searches they replace: generated trees
  (`assistant-data/`, `node_modules/`, `app/web/dist/`) are invisible to them,
  and a session that must look there still needs the shell.
- `backgroundWorkBackend.ts` owns pi's `host-process` backend and the coding
  personas' eager `bash`/`monitor` provider-native shadow definitions.
  Foreground Bash delegates to a fresh upstream `createBashTool` with the same
  cwd, streaming, truncation, timeout, cancellation and process-tree cleanup
  behavior. It passes through pi's shell path and command prefix; its spawn hook
  only restores the current five `PI_*` values. Background Bash and command
  monitors use a PA-owned detached process group and reap that exact group when
  its leader exits, as well as on supervisor Stop. `bash.timeout` may shorten
  the supervisor lifetime through the same per-command timeout pi already
  exposes; Monitor `timeout_ms` instead requests a frozen admission lifetime
  capped by Settings. WebSocket monitors accept only public `ws:`/`wss:` targets
  under the shared SSRF policy and own one exact socket. Backend maps are keyed
  by PA item and owner, never by a current session, so work survives
  provider-turn completion and `PiLiveSession` eviction. Command/socket activity
  coalesces for 30 seconds and has 120 model wakeups per item, then remains
  observable through terminal state and evidence. A monitor with `timeout_ms`
  below 30 seconds therefore reports only at completion. Terminal output keeps a
  1 MiB head plus an in-memory 32 KiB tail under private `pa-pi-<pid>-*` roots
  in the OS temp directory, then passes that bounded window through
  `captureTaskOutputArtifact`. The pi cap makes that policy's 64 MiB pre-scan
  refusal unreachable here; binary, non-UTF-8 and write-failed refusals remain.
  Boot uses the ESRCH-only, uid-checked provider-temp sweep in
  `backgroundWorkBoot.ts`. The row stores evidence metadata plus a human outcome
  sentence: "Exited with code N", "Killed by a signal before it could exit", the
  timeout or spawn error, or "WebSocket closed" — with the activity events
  dropped and the bytes omitted at the writer cap appended only when something
  was actually lost. The title comes from `backgroundWork/title.ts`: the shadow
  `bash` takes an optional `description` for background jobs, and a command
  without one is titled by its first line.
- `agentToolAdapter.ts` owns the direct in-process `AgentTool → ToolDefinition`
  adapter (replaced the former MCP client bridge): execute runs the AgentTool
  directly, `ctx.progress` maps to pi `onUpdate`, details/terminate map 1:1, and
  ref-bearing schemas (proxied MCP tools) are inlined via `jsonSchemaToTypeBox`.
  NO tool sets `constrainedSampling`, and `strict: "prefer"` is NOT a safe
  default: pi resolves it against MODEL capability only (never schema
  compatibility) and the codex/azure responses adapters default that capability
  to true, so the provider gets `strict: true` with our unchanged schema and
  rejects the entire request — any optional property (e.g.
  `current_time.timeZone`) fails OpenAI's strict subset, which demands every
  property in `required` plus `additionalProperties: false`. Guarded by
  `agentToolAdapter.test.ts`.
- `toolActivation.ts` owns per-session deferred activation. Exact/query loads
  happen additively inside `find_tools` execute so pi records native deferred
  definitions. Reopen seeds only names both present in `addedToolNames` and
  actually called in the transcript. Live sessions retain additive loads unless
  a user turn follows at least six idle hours, when never-called deferred names
  are pruned; called/eager/loader/builtin tools survive through the ordinary
  `mergedActiveToolNames` path. That merge also owns pi's Plan policy: it
  removes the `edit`/`write` builtins and catalog tools classified with
  local/external side effects, except `task_manage` for durable Task
  organization and `session_spawn` for read-only profile inspection; that tool
  still refuses `spawn`/`propose` against persisted Plan mode. It keeps
  `read`/`bash`/`grep`/`find` and read-only bridge tools, and restores the same
  active set when Build returns. The direct adapter independently rejects
  stale/forged calls to a Plan-blocked tool. Adapter execute callbacks track
  usage. Prompt extras remain absent, so deferred activation and pruning keep
  the rebuilt system prompt constant. A mode flip deliberately calls
  `setActiveToolsByName` through that same path; pi rebuilds the prompt,
  invalidating the prompt-cache prefix once, but the new prompt no longer
  advertises `edit`/`write` in Plan. The module also serves
  definition-size/used/load-event diagnostics in `SessionState.toolExposure`;
  `docs/tool-discovery.md` records the measured cache rationale.
- `toolPayloadProbe.ts` is the opt-in pi `onPayload` measurement seam. With
  `ASSISTANT_TOOL_PAYLOAD_PROBE_FILE` set, it writes only request sizes, hashes,
  and adjacent common-prefix lengths for `measure:tools`; raw request content is
  never persisted.
- `models.ts` owns the pi `ModelRuntime` (canonical async model/auth facade,
  created with top-level await; passed to every `createAgentSession`) plus its
  synchronous `ModelRegistry` views, and model listing/lookup/refresh
  (`refreshModels` is async). Model projection and first-send lookup use the
  selected profile's registry, so one OpenAI account never advertises another
  profile's OAuth/Copilot/custom models. `refreshModels` is the Settings button
  and only that, so it refreshes with `force` — pi otherwise keeps a four-hour
  catalog freshness window and a click inside it never reaches the network — and
  it fans out over every OpenAI credential profile's isolated runtime, since
  each owns a separate `models-store.json` that only its own login had ever
  filled. Catalog failures do NOT throw: `refresh()` resolves with a
  per-provider `errors` map, and `getError()` reports a different set
  (models.json config, provider composition, availability), so both are
  collected — discarding the map would make an unreachable catalog look like a
  clean update. Every entry is labelled by provider and account and joined into
  `error`; the default runtime's projection is still the answer. Its default
  runtime and every `DefaultResourceLoader` use the PA-owned
  `DATA_DIR/credential-profiles/default/pi-agent/` directory for
  auth/models/settings — never `~/.pi` or a global pi installation.
  `credentialProfiles.ts` makes the documented one-time startup seed from a
  legacy `~/.pi/agent` only when that protected destination is empty;
  `ASSISTANT_LEGACY_PI_AGENT_DIR` overrides that source and can point to a
  nonexistent path to disable the seed. Every subsequent runtime read remains
  PA-owned. `startOpenAiProfileLogin` delegates device-code OAuth to pi and
  exposes only short-lived verification instructions through the
  credential-profile registry; tokens remain in the private pi auth file. Pi
  writes OAuth before its post-login model refresh resolves, so a changed
  credential hash completes the UI and the profile projection immediately
  includes that profile's built-in OpenAI models even if the SDK availability
  snapshot is still stale. The underlying operation remains serialized until it
  settles (no overlapping auth/model-file writers), and deleting its profile
  invalidates callbacks plus removes any late provider writes.
  `modelRuntimeForProfile` caches one runtime per selected OpenAI profile, and
  `options.ts` receives that profile id so its resource loader uses the matching
  private agent directory.
- `oneShot.ts` owns headless no-tool one-shot runs (naming, commit, refinement,
  summary, scanner) and shared model fallback selection. Every run is
  account-scoped: callers pass the `credentialProfileId` their settings slot
  resolves to (`settingsModelSlots.ts`), and the run uses THAT profile's
  `modelRuntimeForProfile` runtime and `piAgentDir` resource loader — never a
  global `~/.pi` agent dir or the default profile's runtime.
  `selectPiModelWithFallback` resolves against the same profile's registry, so a
  fallback can never hand one account's model handle to another account's
  runtime.
- `openaiUsageQuery.ts` owns the Usage page's OpenAI account reads/mutations.
  All reads, including an omitted API profile id, resolve to the PA-owned
  default profile's `pi-agent/auth.json`; deps
  (`readAuth`/`fetchUsage`/`fetchResetCredits`/`postConsume`/`now`/`newRequestId`)
  are injectable for tests, and it does NOT import the pi SDK.
  - `fetchOpenAiUsage` (backing `GET /api/usage/openai`) calls
    `GET /backend-api/wham/usage` and maps the loose response into the stable
    `OpenAiUsageSnapshot` (`mapOpenAiUsageResponse`). Windows are classified by
    DURATION (`classifyWindow`), never by the raw primary/secondary names. It
    then BEST-EFFORT enriches per-credit reset detail (expiries) from
    `GET /backend-api/wham/rate-limit-reset-credits` (`mapResetCredits`, sorted
    soonest-expiring first) — a failure there leaves counts-only, never failing
    the snapshot. READ-ONLY: it never refreshes the token; missing creds /
    expired token (`expires` or a 401/403) degrade to `available: false` with a
    re-run-pi hint; only unexpected failures throw (→ route 502).
  - `redeemOpenAiResetCredit` (backing `POST /api/usage/openai/redeem-reset`)
    redeems ONE banked reset via
    `POST /backend-api/wham/rate-limit-reset-credits/consume` — IRREVERSIBLE (a
    2xx spends the credit). A server-side guard re-checks `/wham/usage` and
    REFUSES (throws with `notApplicable`, → route 409) unless
    `applicable_available_count > 0`, so a credit is never burned while no
    window is hit. This is defense-in-depth behind the UI's confirm dialog +
    disabled-button guard.
- `sessionOpen.ts` owns reopening existing pi session files without letting the
  SDK mint new ids.
- `forkOrigin.ts` owns fork-origin custom entries and fork auto-rename state.
- `titleState.ts` owns Pi live-title hydration and first-prompt auto-name
  guards; use durable native branch/session-index state instead of transient
  provider context when deciding whether a prompt may name a session.
- `piPromptMeasure.ts` owns the pi-side inputs of the prompt inventory
  (`../promptInventory.ts`): it loads pi's own `buildSystemPrompt`, the prompt
  extras of the builtin definitions a coding session really activates
  (`read`/`bash`/`edit`/`write` plus `PI_SEARCH_BUILTIN_TOOLS`), and
  `loadProjectContextFiles`, so the measurement reports what pi really
  assembles. `piBuiltinDefinitionChars` prices those same builtins on the WIRE
  (name + description + schema) for the inventory's
  `tools:eager:harness-builtin` row — pi's prompt carries only their one-line
  snippets, so without it the report would price the whole builtin block at ~126
  characters. `buildSystemPrompt` is not in pi's `exports` map, so it is
  imported by resolved file path — a deliberate, measurement-only reach into pi
  internals that throws (and fails `promptInventory.test.ts`) if a pi upgrade
  moves it. Skills and the agent-dir global context file are excluded so a
  baseline does not depend on the measuring machine's `~/.pi`, and `build`
  replaces pi's own install directory with `PI_PACKAGE_LABEL` for the same
  reason: pi's default prompt names its README, docs and examples by absolute
  path three times, so the raw text would price the checkout's location (~675
  characters between a CI container and a developer checkout) and shift on a pi
  version bump, which pnpm encodes in the store path.
- `toolBinaries.ts` owns pi's managed bin dir (`piBinDir()`, which
  `backgroundWorkBackend.ts` also prepends to PATH) and the boot-time links of
  the host's `rg`/`fd` into it. With those links in place, pi's grep/find stop
  probing PATH with a synchronous fork on every call
  (`docs/child-processes.md`). The directory comes from pi's process-wide agent
  dir, not a credential profile's, because pi's tools manager fixes it when the
  module loads. In production that is the service user's `~/.pi/agent/bin`, the
  same directory pi's own bash PATH and managed downloads already use. It is the
  one path under `~/.pi` this app writes, and it only ever creates symlinks
  there, never replacing or removing an entry. The cross-process check in
  `toolBinaries.test.ts` loads pi's `tools-manager.js` by resolved file path, so
  a pi upgrade that changes the lookup fails that test.
- `index.ts` owns the public surface, including type re-exports of pi package
  types for non-piSdk consumers.

## Contract notes and rationale

- Only this folder imports `@earendil-works/*` (guarded by
  `architecture.test.ts`); non-`piSdk/` modules may use focused `piSdk/` entry
  points, but must not import the pi package directly.
- No static import of `hub.ts` anywhere in this folder; hub behavior arrives via
  `piStore.setHost(...)`/`PiSessionHost` injection.
- Drive sessions through the runtime prompt facade/adapter; `PiLiveSession` raw
  prompting stays private.
- Pi tools always come from the direct adapter over `toolActivation.ts` (the
  session MCP server serves Claude/external only). The full tool universe
  registers up front (pi cannot add DEFINITIONS mid-session); every active-set
  change flows through the activation's `applyActiveToolNames` merge →
  `setActiveToolsByName`, and additive activations must happen inside a tool's
  execute window to stay cache-friendly.
- Session-open/canonicalize paths encode pi SDK footguns (id minting on empty
  headers, pending-output retargeting); change them only with
  `sessionResolver.test.ts` green.
- Per-session cwd: sessions execute in their worktree path when a
  `session —in_worktree→ worktree` edge exists (`worktrees/sessionCwd.ts`
  resolves it on reopen/fork); every create/open path must thread the cwd
  through `buildAgentOptions`, `SessionManager.create/open`,
  `createAgentSession`, and the tool session — never fall back to a hardcoded
  `CWD` in one of them. Reopen precedence: edge cwd → the session file's own
  header cwd (sessions created in a non-CWD directory, e.g. merge agents) → app
  CWD.
- Aborted turns stay lossless (partial content + completed tool results
  persist).
- Turn-completion usage (`agent_end` for retry attempts, `agent_settled` for the
  final attempt, and the adapter `completionMetadata` fallback) is the attempt's
  delta: pi's cumulative `getSessionStats()` sampled at `agent_start`
  (`turnStartTotals`) diffed via `perTurnUsage`, with `contextTokens` from
  `stats.contextUsage`. Never attach cumulative stats to an entry.
- Automatic retries remain one runtime turn but persist one assistant entry per
  attempt. If more than one attempt contains output, provider binding refuses
  the ambiguous turn rather than assigning unsafe fork/resume anchors.

## Verification commands

- Run `pnpm --filter @assistant/server test src/piSdk` for this subtree's tests.
- Run `pnpm --filter @assistant/server typecheck`.
- Run root `pnpm run build` before closeout.
