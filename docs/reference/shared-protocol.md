# Shared protocol package — implementation reference

Relocated from `app/shared/CLAUDE.md` (Task-274) so it stops costing agent
context on every visit. This is a descriptive snapshot of what the modules in
that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Shared TypeScript package for server/web wire protocol, runtime event
vocabulary, display projection, and normalized session model types.

## Module ownership

- `protocol.ts` owns the Sessions-inbox session-list contract: beyond the
  durable metadata, `SessionListItem` carries `createdAt`, the precise
  `attention` kind (`SessionAttentionKind`, alongside the coarse
  `awaitingInput`), the volatile `runStartedAt`, the persisted `lastError`
  (`SessionRunFailure`, bounded server-side), `queuedWork`, and `settledAt` —
  settlement being a first-class state distinct from `archived`.
  `settleBlockedReason(session)` is the ONE settle-eligibility predicate,
  deliberately shared: the browser disables its action with it and the server
  refuses the `settleSession` command with it, so the two cannot drift.
  `isShelvedSession(session)` is the one "on the Settled shelf right now" answer
  (settled, and not blocking on a human decision). The spawn-cluster fold lives
  here too, because the server settles along it:
  `spawnClusterMembers(sessions, runs, cards)` picks the candidates (unarchived,
  minus the roles of every run `workflowRunInWorkingSet` keeps as an item,
  `workflowRunOwnerBySession`), `spawnClusterForest(members)` folds them along
  `coordinator`-owned edges — a shelved peer folds only while an unshelved
  member folds into it, depth is unbounded, and a cycle is broken at its first
  id — `spawnClusterDescendantIds(rootId, forest)` is what a card shows folded
  and what its Settle shelves, `spawnClusterSettleBlockedReasons` answers every
  member's refusal in one bottom-up sweep for surfaces that disable every row,
  and `spawnClusterSettleBlockedReason` is the aggregate refusal (own reason,
  else the first blocked descendant in forest order) every Settle surface
  disables with and the server refuses with. `SessionOutcomeAttention` is the
  durable half of that state ([Task-674](pa://task/674)): a monotonic revision
  raised by a completion or a failure, the revision Settle acknowledged, and the
  current outcome's kind and time. `pendingSessionOutcome` is the ONE derivation
  of "not acknowledged yet" — the server withholds `settledAt` from a row that
  has one, the browser projects the card's status from it — and
  `isDirectlyOwnedSession` is the ONE ownership gate for whose outcomes those
  may be (everything except a coordinator-owned spawn). The server then
  distinguishes a directly owned coordinator's intermediate peer wake from its
  final user-facing outcome. `settleSession.throughRevision` is what the clicked
  row saw, so a stale click cannot acknowledge an outcome it never rendered; it
  is REQUIRED, because acknowledging whatever the server holds now is a
  privilege only a server-side settlement may take and an optional field would
  hand it to any client that omitted it. `SESSION_READ_DWELL_MS` is shared for
  the same reason: it is how long a session must stay OPEN before reading it
  counts as read, and BOTH the server's durable read mark and the browser's own
  "the session I am looking at is never unread" rule wait it out, so an opened
  card moves once rather than twice. `WORKTREE_MISSING_BLOCKED_REASON` is the
  third of that family ([Task-321](pa://task/321)): the single wording for a
  session whose `in_worktree` worktree is gone, carried by the server's refusal
  and the browser's banner, with `worktreeMissing` on both `SessionListItem` and
  `SessionState` meaning "dead edge, not yet acknowledged" — distinct from
  simply having no `worktreeId`, which is an ordinary app-CWD session.
  `delegation` (`SubagentDelegationSummary`, [Task-495](pa://task/495)) is an
  independent, compositional dimension on that row: active child runs are split
  into starting, working and awaiting-parent counts without changing the meaning
  of the parent's own `isStreaming`/`runStartedAt`. The shared
  `delegationObligationReason` gives settlement and Workflow completion one
  truthful immediate-parent refusal, prioritizing active runs, then results not
  yet durably admitted to the parent transcript, then managed delegated
  worktrees. `settleBlockedReason` feeds it the row's active count, so browser
  and server settlement cannot overlook delegated work. `backgroundActivity`
  (`SessionBackgroundActivity`, [Task-482](pa://task/482)) is a third such
  dimension, for session-owned background shell and monitor work: active counts
  by kind plus the oldest start, so a provider-IDLE session can still be visibly
  busy. It never sets or derives `isStreaming`, `runStartedAt`, `unread` or
  `SessionSnapshot.runState`, and `backgroundWorkBlockedReason` gives settlement
  and destructive deletion the same one refusal, which `settleBlockedReason`
  consults after delegation and `onDeleteSession` checks before any destructive
  step. A retained host with no items left still blocks: the epoch outlives its
  last task by design, so zero active work is not the same as nothing running.
  `BackgroundWorkItemSummary` is the registry row: PA id, owner session,
  backend/kind, the human title (`label`: the agent's `description` when it gave
  one, else the command's first line), the `command` itself bounded at
  `BACKGROUND_WORK_COMMAND_MAX_CHARS` (4 KB, `commandTruncated` when cut — a
  WebSocket monitor carries its URL there), state, Stop state, frozen deadline
  and evidence facts, with the vendor task id reduced to a `providerBound` flag
  — vendor ids, process ids, environment, cwd, paths and output bodies never
  enter the wire model. The command is on the wire on purpose: it is the same
  text the transcript's tool call shows, and a card that cannot say what ran is
  a card nobody can read. `backgroundWorkList` — the `background` topic's
  subscribe/resync answer — carries those rows as a BOUNDED window rather than
  the whole member set, since the registry keeps its terminal history
  ([Task-656](pa://task/656)); its optional `truncated` says older rows were
  left out, and nothing on the wire asks for the next window.
  `BackgroundWorkPromptPresentation` (the chat card's browser projection in
  `session/origin.ts`) carries the same three fields per update.
  `BackgroundWorkSettings` (`AppSettings.backgroundWork`) is the governance card
  for that work: `enabled` default true, `ownerSessionCap` default 7 in 1–20 — a
  cap on OWNING SESSIONS, since one slot is shared by all of a session's
  children — `taskLifetimeMinutes` default 60 in 5–1440, and
  `claudeEmptyHostGraceSeconds` default 30 in 0–300, with
  `DEFAULT_BACKGROUND_WORK_SETTINGS`/`BACKGROUND_WORK_SETTINGS_RANGES` shared so
  the card offers exactly what `normalizeBackgroundWorkSettings` accepts (out of
  range clamps to the nearest bound, non-numeric falls back to the default).
  Every value is read once at admission and frozen onto the row, so an edit
  governs LATER admissions only and reshapes nothing already running.
  `backgroundWorkBackendsForHarness`/`harnessSupportsBackgroundWorkBackend` are
  the capability predicate beside them: Claude background work runs inside the
  retained query that issued it (`claude-query`), pi background work is
  supervised by PA itself (`host-process`), and neither runtime can hold the
  other's — so an admission naming the wrong one is a mismatch, not a
  preference. Widening a harness to a second backend is a deliberate act.
  `stopBackgroundWork`/`stopAllBackgroundWork` are the HUMAN Stop requests
  ([Task-486](pa://task/486)); the server resolves the owner from the durable
  row and calls the supervisor's domain service directly, never the model-facing
  `background_tasks` handler. Their `backgroundWorkStopAnswer`
  (`BackgroundWorkStopAnswer`, outcomes `stopped`, `already-terminal`,
  `awaiting-binding`, `stop-unconfirmed`, `unknown`) is CONTROL feedback that
  retires a pressed button; the rows themselves travel only as `background`
  state events, and `hostCloseWaiting.protectedTurn` reports a retained host
  whose close is waiting on the user's own prompted turn rather than pretending
  it closed. `SubagentUsageTotals` is the additive finalized-entry token/cost
  shape; `subagentUsageSnapshotFromEntries` deliberately ignores streaming
  estimates and context occupancy, reports partial when a finalized assistant
  entry lacks usage, and rounds cost per durable entry like `sessionStore`.
  `pullRequest` (`SessionPullRequestSummary`, [Task-342](pa://task/342)) is the
  same idea for the session's live `/pr` card: the card is durable state of one
  session's transcript, so a LIST could not otherwise say which session is the
  one waiting on a review. It carries only what a row states — status, number,
  CI, review, conflict, draft — never the card's body, warnings or linked Task,
  and the type itself owns the rule that ONE card speaks for a session (the
  newest still-moving one, else the newest terminal one) plus the warning that
  its `ci` is a SNAPSHOT the watcher abandons once the card leaves `open`, so no
  reader may rank it against a terminal status. Volatile fields (`isStreaming`,
  `runStartedAt`) must be neutralized when a browser restores its shell cache.
- `protocol.ts` owns `SessionScope` ([Task-492](pa://task/492)), the three-way
  classification persisted with a session row: `user` (the user's own
  conversation, the ONLY scope a broad/default projection carries), `internal`
  (a server-only usage-attribution helper run) and `subagent` (a session PA runs
  under a subagent thread, reached through the registry rather than the
  sidebar). It is a property of the SESSION, not of a run, and never derived
  from who started it. `sessionScopeOrFailClosed` is the one parse, and it fails
  CLOSED: an unrecognized value resolves to `internal`, so a row a build cannot
  classify is hidden rather than shown as the user's — widening is always
  deliberate. `SessionListItem.scope` carries it where session summaries already
  travel; absent means the user's, because a default projection carries nothing
  else.
- `protocol.ts` also owns `SessionToolExposure`, the Tools-inspector wire
  projection. Each tool carries group/tier/usability/load state, exact
  definition characters, actual-call usage, and optional harness token size;
  counts include loaded-but-unused tools and definition characters, with a
  bounded activation-event trail.
- `protocol.ts` owns the legacy/current WebSocket and API-facing app protocol
  types, including compact `SessionObjectRef` relationships, immutable
  `credentialProfileId` bindings projected on session-list rows, and safe
  `CredentialProfileSummary.enabled` account availability (disabled profiles
  remain durable for existing bindings but are excluded from new work).
  `CredentialProfilePin.credentialProfileId` is the optional account pin every
  configured model slot extends (unset = automatic: the first enabled account of
  the model's provider, which is also the fallback when a pin cannot be
  honored), `AccountModelOption` is the account/model combination the settings
  pickers offer, and `CredentialProfileUsage` reports what depends on one
  account (pinned slots, bound sessions, automatic-pick status and its
  fallback). The worktree-review handoff distinguishes immediate
  existing-session delivery from editable new-session drafts carrying explicit
  harness/persona/model/thinking/mode/profile, user prompt, and optional
  attachments (`attachWorktreeComments`). A draft is staged on the ordinary
  new-session surface, where Build/Plan is picked next to the model, so
  `session.mode` travels with the rest of that runtime and both creation paths
  (pi and claude-sdk) apply it — a review session created in Build after the
  composer showed Plan would run tools the user withheld.
  `harnessSend.createWorktreeInProjectId` is the "+ New worktree" staging of the
  new-session surface: the server provisions a checkout in that project BEFORE
  creating the session (a session's cwd is fixed at construction in both
  harnesses), reports each phase as `worktreeProvision` echoing the send's
  `clientRequestId`, and on failure creates no session and runs no turn. The
  browser renders those phases as a client-overlay card and re-issues the held
  send on Retry; the succeeded provision becomes the durable `worktreeProvision`
  host-command card (`WorktreeProvisionDisplay`, live envelope
  `worktreeProvisionResult`), which is the session's genesis entry and therefore
  precedes its first user prompt. Worktree write APIs include
  manual/agent-generated commit, HEAD-scoped clean, push, deterministic
  pull/rebase/rebase-main/fast-forward-main synchronization, and hosting/PR
  result contracts. `WorktreePullRequestReview` carries the standing human
  review on an OPEN PR (`changesRequested`, plus an OPTIONAL `unresolvedThreads`
  — thread resolution is not reachable over the REST surfaces used, and
  reporting 0 where we cannot tell would read as "all resolved"), and
  `WorktreeHostingListResponse` is the whole-list projection behind
  `GET /api/worktrees/hosting`, which omits a worktree whose PULL-REQUEST lookup
  failed rather than returning it empty — a failed CI or review read keeps the
  row and leaves only that field absent, which already means unknown, so an
  answered pull request survives an unrelated outage.
  `HostedPullRequest`/`ProjectPullRequests` are the per-repository open-PR list,
  server-side only now that its HTTP route is gone: richer than
  `WorktreePullRequestInfo` because that list is BROWSED rather than attached to
  a branch you already have — it carries head/base branches, authorship, and
  whether it is waiting on YOU (`mine`/`reviewRequested`, both false when the
  identity could not be resolved, since claiming unverified ownership would put
  someone else's work in your inbox).
  `PullRequestInventoryItem`/`PullRequestInventoryResponse` back
  `GET /api/pull-requests`, the Pull Requests view's own projection. It carries
  `repositoryKey` (`owner/repo`) because the CLIENT has to name the repository
  too — one project can hold two, and both number a pull request 7, so a
  project-and-number address would give two rows one URL. The same identity plus
  the hosting detail a decision needs (`ci`, `review`, three-valued `mergeable`,
  `headSha`, `capabilities`), a `state` that also admits `merged`/`closed` for
  the cleanup queue, and the local joins the client cannot make as IDS ONLY
  (`worktreeId`, `sessionIds`, `taskIds` — the web already holds those records
  and resolves them itself). `PullRequestViewMergeRequest`/`…Response` are that
  view's one action, `POST /api/pull-requests/merge`: the request carries the
  same four-component identity and NOTHING derivable from it (no branch, SHA or
  path), with each consequence as its own field whose omission is the SAFE
  answer — an absent `removeWorktree` removes no checkout, while an absent
  `deleteRemoteBranch` deletes, as the card's merge always did. The response is
  PER PHASE (`PullRequestViewMergeOutcome` + `PullRequestViewCleanupOutcome`)
  precisely so a landed merge and a refused cleanup cannot be collapsed into one
  verdict: the merge reports what happened to the remote branch rather than what
  was asked, and the cleanup reports the retirement's own `refusalKind`,
  `branchDeleted`, `settledSessions` and `deliveryVerified`.
  `PullRequestViewCheckRequest`/`…Response` are the same identity asked for
  STATE alone (`POST /api/pull-requests/check`): the answer a client needs when
  its action's response was lost, and the one that stays reachable because it
  attempts nothing a merge guard could refuse. Its
  `PullRequestViewCheckoutState` is a UNION — `none`, `one` worktree, or
  `ambiguous` with its reason — because two checkouts on the head branch is not
  an absent one, and an optional id would be read as exactly that.
  `PullRequestViewCheckoutRequest`/`…Response` are the view's REVIEW action
  (`POST /api/pull-requests/checkout`), the same four components again.
  `PullRequestCheckoutOutcome` keeps `created`, `updated`, `already-current` and
  `refused` apart: a checkout already standing at the head did no git work, and
  an `updated` that reports `previousHead`/`head` is claiming one. Every success
  carries `PullRequestCheckoutBase` — the RECORDED merge-back target beside the
  pull request's own base, and whether they match — because a recorded base that
  is not the pull request's decides where the work would land and is not
  something a surface may infer. It also carries the checkout's own LIVE
  `taskIds`, on the wire because the staged review session's Task must be chosen
  the moment the answer lands: an empty array is the server's authoritative
  "this checkout has no live Task" — filtered through the same projection a
  client's Tasks list is built from, so an archived link is neither attached nor
  left to suppress a weaker one — while a browser's Tasks list that has not
  loaded says nothing, and a client deciding from the latter drops an
  authoritative link or lets a `/pr` card's Task overrule a checkout-owned one.
  `PullRequestCheckoutRefusalKind` enumerates what the action will not resolve
  by guessing (`head-unreachable`, `head-moved`, `dirty`, `diverged`,
  `not-tracking`, `branch-exists`, `ambiguous-checkout`, `base-unresolvable`,
  `raced`, `update-failed`); all of them are DATA on a 200, since the endpoint
  attempted nothing it could not report. `raced` is its own kind because it is
  NOT `update-failed`: the operation refused under its lock before touching
  anything, because the checkout or its upstream moved past the state that was
  verified. `WorktreeRecord.mergePhase` carries the phase of a merge that has
  NOT finished, from the worktree's persisted merge state: `worktreeMergeUpdate`
  is an EVENT, and an event that fired before a browser subscribed is one it
  never hears, so the record is what makes a merge stuck on conflicts survive a
  reconnect. `boundMergeMessage`/`MERGE_MESSAGE_MAX` bound that message, and
  live HERE rather than on either side because both apply it: the server before
  it broadcasts or projects one, the browser before it renders one.
  `PullRequestDetail` (state, merged, mergeable, draft, headSha, baseBranch) is
  the point-in-time poll shape `pullRequestWatcher.ts` reads off
  `gitHosting.ts`'s `pullRequestDetail`; `mergeable: null` means the provider
  cannot answer it yet — GitHub while it recomputes, Forgejo on a draft/WIP pull
  request — and must be polled again, never rendered as conflicting.
  `WorktreeGitStatus.changedAt` records when the worktree's git state last
  actually CHANGED, as distinct from `updatedAt` which every scan stamps —
  including the routine rescan after a fetch that found nothing. Anything that
  ORDERS or AGES by activity must read `changedAt`, or a quiet worktree looks
  freshly active every few minutes and the list reshuffles with nothing behind
  it. The `upstream` and `baseUpstream` counters carry an optional `name`: Git's
  resolved short upstream (for example `fork/feature`), so clients never infer a
  remote from the branch name; absence supports older servers and renders as a
  generic relationship label. `WorktreeGitStatus.fetchedAt` records when the
  repo's remote-tracking refs were last refreshed: every `behind` count in that
  projection is only as current as that stamp, so ABSENT means never fetched
  rather than current, and a consumer rendering those counts must degrade
  instead of asserting freshness.
- `protocol.ts` owns `SlashCommandInfo` and `slashCommandApplies`, the one
  applicability rule the web composer (menu population + interception) and the
  server (pre-dispatch validation) both run. `execution?: "host" | "client"` is
  the dispatch axis: omitted/`"host"` commands go over the wire as
  `runSlashCommand`, while a `"client"` command (e.g. `/review`) is handled
  entirely in the web app — the composer routes it to its `onClientSlashCommand`
  prop and the server rejects it if a stale client dispatches it anyway. `/pr`
  is a host command, but its pull-request phase renders no `HostCommandCard`:
  the live `PullRequestCard` (`renderKind: "pullRequest"`, `choosing-task` →
  `creating` → `open` → `merged`/`closed`/`failed`) is store-driven like
  `ApprovalCard`, riding the `pullRequest` `DisplayBlock` and the
  `pullRequestCardUpdate` message rather than a durable `command.result` entry —
  it keeps changing (CI, review, mergeability) long after the command's
  synthetic tool turn ends. Stage 3 puts the ACTIONS on the same card:
  `PULL_REQUEST_CARD_ACTIONS`/`PULL_REQUEST_MERGE_METHODS` are exported as const
  arrays so the client renders and the server validates the same sets, the
  `pullRequestCardAction` client message carries `mergeMethod` only for a merge
  (a per-merge decision, never defaulted server-side), and the running action
  (`busyAction`), its outcome (`actionMessage`/`actionError`), the accepted
  rebase handoff (`rebaseHandedOff`, the last update-with-main's conflict now
  running as a prompt in the session), the session's `worktreeId` and the
  `cleanedUp` flag live ON the card so they survive a reload and reach every
  viewer. `PullRequestDetail.headBranch`, `PullRequestMergeResult` and
  `PullRequestCloseResult` (a close that landed but could not be confirmed is
  `closed: false` with an `unconfirmedReason`, never an invented success)
  complete the provider seam; `WorktreeMergePrRequest`/`Response` is the same
  merge over HTTP for the worktree page. `PullRequestRepositoryCapabilities` —
  carried on the card (`repositoryCapabilities`) and on
  `WorktreeHostingStatusResponse` (`capabilities`) — states what ONE repository
  allows: its exact provider-reported default branch, the merge methods it
  permits in the shared vocabulary's order, an optional provider default method,
  and close/ branch-deletion support. Every field is optional and absence means
  UNKNOWN, never "all methods are supported" and never a guessed `main`, so a
  picker offers only what is reported and nothing at all while it is unknown.
  One registry and one help list either way; a known command is ALWAYS
  intercepted, never forwarded to the model.
- `protocol.ts` owns the small dedicated Claude-login terminal contract
  (`ClaudeLoginClientMessage`/`ClaudeLoginServerMessage`/status) used only on
  `/ws/claude-login`; it carries bounded terminal text and lifecycle state,
  never profile credentials or echoed authorization input, and deliberately
  stays outside the main `ClientMessage`/`ServerMessage` unions.
- `protocol.ts` also owns the dictation contract: `SpeechToTextSettings` (an
  `AppSettings` section), the deployment-state `SpeechToTextStatus` (carried on
  `ready` AND re-sent as a `speechToTextStatus` message after any `speechToText`
  settings save, since `modelId` selects among installed models and a stale
  health line would misreport availability until reconnect), and the
  `SpeechClientMessage`/`SpeechServerMessage` unions for `/ws/speech`. Those two
  unions are deliberately NOT part of `ClientMessage`/`ServerMessage` — the
  audio socket has its own validator, so the session socket's exhaustive
  per-type validator registry stays untouched. `SpeechToTextSettings.modelId`
  names a catalogued model id, never a filesystem path.
- `speechVocabulary.ts` owns `applySpeechVocabulary`, the post-decode
  `spoken → written` rewrite engine (whole-word, case-insensitive, literal
  replacement, ALL rules in ONE pass so no rule rewrites another's output),
  re-exported from `protocol.ts`. It lives here rather than in the server
  specifically so the Settings vocabulary editor's live preview runs the EXACT
  code the server applies after decoding — a browser-side reimplementation would
  drift and make the preview lie about what dictation will do.
- `protocol.ts`'s `CompactionDisplay` is the harness-neutral compaction card:
  `summary`/`tokensBefore` always, plus `tokensAfter` (claude-sdk, from the
  CLI's compact boundary) and `firstKeptEntryId` (pi, its first retained session
  entry) only when that harness actually measures them. Renderers must degrade
  rather than substitute a value.
- `runtimeEvents.ts` owns runtime-native event and snapshot payload types, and
  with them the WINDOW the chat load is bounded by. A `ClientSessionSnapshot`
  carries the timeline's bounded tail plus `timelineStart` / `totalEntryCount`,
  so the client knows what precedes what it holds; `timelineWindowStart` and
  `timelineRangeStart` pick that cut under two budgets at once — entry count
  (`SNAPSHOT_TIMELINE_WINDOW_ENTRIES`) and payload bytes
  (`SNAPSHOT_TIMELINE_WINDOW_BYTES`) — because projected entries differ in size
  by an order of magnitude. Both bounds hold on the slice that is actually sent,
  with two documented over-runs: the entry FLOOR
  (`SNAPSHOT_TIMELINE_MIN_ENTRIES`, a snapshot too short to fill the first
  screen would only be asked for again), which exceeds only the byte budget and
  is capped at its own entry count, and the RENDERABILITY floor — a cut inside a
  long tool loop can leave a slice of nothing but orphan tool results, which the
  display projection renders as zero messages (the client then mistook the
  session for empty), so such a slice is extended back to the nearest assistant
  entry declaring any of its calls. That floor outranks BOTH budgets (an orphan
  run longer than the window pushes the start below the entry bound too), and
  its cost is the tail of one turn: replayed over the 662 stored session logs
  when it shipped (Task 449), the four windows it extended measured 199–369 KB
  against the 180 KB byte budget — whoever tunes
  `SNAPSHOT_TIMELINE_WINDOW_BYTES` should treat the bound as soft by up to ~2x
  on a tool-loop-heavy session, the accepted price of keeping every window
  renderable without a standalone orphan-result row in the display contract.
  Within the budget the cut prefers the furthest-back TURN START, because
  cutting mid-turn drops that turn's tool results from the display projection
  (their declaring assistant entry is outside the window) and leaves a turn
  fragment. Two cases are answered mid-turn on purpose: a single turn longer
  than the budget (starting at its prompt would ship the whole turn), and a
  boundary so close to the tail that starting there would render less than the
  floor. Those windows are NOT presented as turn-aligned — the seed carries
  `partialTurn` (see `turnStats.ts` below). The versioned
  `TimelineCacheDescriptor` describes a RANGE (`startIndex` + `entryCount` +
  fingerprint), not a prefix, so a browser holding a windowed tail still earns a
  tail-only snapshot (`timelineBase`) and gets back the anchor to persist
  (`timelineCache`); an empty descriptor is the client's "my copy is gone" and
  is answered with a window, never the whole timeline. A MATCHING anchor is not
  automatically honoured either: `timelineRangeIsRenderable` is the exported
  half of the renderability floor, and the range a client would render has to
  pass it (Task 450 — browsers that cached a pre-floor window held a legitimate,
  fingerprint-matching range of nothing but orphan results, so the server kept
  answering with the empty tail after it and the transcript stayed blank through
  every reopen). A cached range cannot be extended, so it is DROPPED for the
  window; the same predicate keeps the web client from persisting such a range
  or splicing one. It is structural (O(slice), no allocation, so an attach can
  ask it about a multi-thousand-entry range) and diverges from the projection in
  one case only: a host-command card of a kind the build no longer knows. Bump
  `SESSION_TIMELINE_PROJECTION_VERSION` whenever an existing entry's lazy client
  projection can change (2 since [Task-697](pa://task/697) kept card-from-input
  tool inputs whole).
- `protocol.ts`'s `timelineBlockFailed` answers one `loadTimelineBlock` that
  could not be served, naming the block so the client retires exactly that read:
  `unavailable` is terminal, `error` may be retried.
- `toolCards.ts` owns the ONE rich-card acceptance rule ([Task-697]
  (pa://task/697)): `toolCardOf` decides, from a tool's name, arguments, output
  text and error flag, which card (if any) a completed result renders as, and
  carries the cards' own parsers (`parsePeerPromptCard`, `showFilesCardRowsOf`
  with a caller-supplied address resolver, `parseTaskManagePayload`,
  `knowledgeEntryCardOf`, the worktree display validators). The web registry
  matches renderers with it and the server's payload policy keeps a payload
  whole with it, which is what makes a card that renders live render again after
  a reload; `toolCardReadsInput`/`toolCardReadsOutput` say which half of the
  call each card actually reads. A card predicate must never be re-implemented
  on one side. `session/sha256.ts` is the dependency-free SHA-256 behind
  `bodyContentHash`, the collision-resistant identity a lazy ref carries so a
  browser can prove a body it holds is the persisted one.
- `runtimeEvents.ts` holds TWO event vocabularies. `RuntimeEvent` is what the
  runtime emits (full bodies, raw entries) and is consumed by server observers;
  `ClientRuntimeEvent` is what a viewer receives on the `event` channel, and
  only the transport builds it. The difference is the live-body projection: text
  deltas stream, thinking blocks and tool bodies arrive as `LiveBodyRef`s
  (`session/content.ts`: stream id, block index, kind, length, lines) through
  `liveBodyProgress`/`toolEnded`, durable rows arrive as `timelineDelta` (every
  touched entry, lazily projected like a snapshot), and body text arrives only
  as `liveBody` frames for bodies the viewer put in `setLiveBodySubscriptions` —
  a `replace` snapshot on subscribe, `append`s with an `offset` after.
  `AgentContentBlock` carries `lazy` on durable projections and `live` on
  in-flight ones, never both; `StreamingToolEntry` mirrors that with
  `inputLive`/`outputLive`. The display projection passes the refs through
  (`DisplayBlock.live`/`argsLive`/`outputLive`) so a block can subscribe from
  what it renders. The full contract is in `docs/reference/server-session.md`.
- `turnStats.ts` owns the transcript's turn math — `groupTurns`,
  `turnTotals`/`turnRuns`, `promptCacheHitRatio`, `finalResponseBoundary`, and
  the running walk `accumulateTurnStats` — and lives here rather than in the web
  package BECAUSE the transcript is windowed: the renderer only holds a suffix,
  so the server computes a `TurnStatsSeed` for everything before it
  (`turnStatsSeedForWindow`, the one derivation both wire paths use) with the
  very same walk, and the client continues from it. Every COMPLETE turn in the
  window therefore renders the row an unwindowed list would, and a "load
  earlier" answer carries a seed for the NEW start, which is what leaves those
  rows untouched. The exception is the leading turn of a mid-turn window: the
  seed says `partialTurn`, `accumulateTurnStats` marks that row `partial` (and
  does not re-count its turn), and the renderer draws NO turn-end row for it — a
  fragment's totals are a fraction of the turn's and would change on the next
  range load, which is the one thing this seed exists to prevent. Two
  correctness details the renderer must not re-derive: `contextSizeIsEstimate`
  flags the fallback where the last run's `input + cacheRead + cacheWrite`
  stands in for a missing snapshot (rendered with a `~`), and
  `promptCacheHitRatio` divides cache reads by ALL prompt tokens because a cache
  WRITE is a miss processed at a premium — the turn line, the session line and
  the expanded percentages all call that one function so they cannot drift.
- `displayMapping.ts` also owns the optional `DisplayProjectionCache`
  (`createDisplayProjectionCache`). The client re-projects the WHOLE timeline on
  every runtime event — up to once per animation frame while a turn streams,
  over a session that runs to thousands of entries — so without it every
  `DisplayMessage` is reallocated per frame and every memoized transcript row
  re-renders: measured at **1761 of 1761 messages replaced per frame, versus 1
  with the cache** (and 1.32 → 0.83 ms per projection). Reuse is keyed on the
  IDENTITY of an entry plus everything folded into it (its tool results, and any
  live tool stream merged into its blocks), which is sound because the reducer
  replaces only the entries it touches. The cache is a pure accelerator: a hit
  can only return what a rebuild would produce, so a stale or foreign key costs
  a miss and never a wrong answer, and `entriesToDisplayMessages` with no cache
  stays the plain reference behaviour the server's one-shot reconnect projection
  uses. Two invariants keep it honest and are pinned in
  `displayMapping.test.ts`: tool-call OWNERSHIP is resolved in a first pass that
  replays the original forward-walk rule (a call id belongs to the last
  assistant entry that declared it before the result arrived), and the cached
  and uncached projections must be deep-equal.
- `displayMapping.ts` owns projection from normalized timeline entries to
  `DisplayMessage[]`, including each durable message's `createdAt` (used to
  interleave legacy store-backed approvals chronologically) and the assistant
  entry's per-response `usage`/`model`/`startedAt`/`completedAt` (so the chat
  can render per-turn and per-provider-run token/cost stats without any
  live-only data), and the tool block's `resultDiff` — a RENDERING-ONLY provider
  display diff carrying the file's real line numbers (pi's edit tools report one
  in the tool result `details.diff`; the model-facing text only says the edit
  succeeded). It rides on `ToolResultSessionEntry.resultDiff` and the live
  `toolEnd` envelope, is never model context, and is absent for harnesses/tools
  that produce none — consumers must degrade rather than invent line numbers.
  `displayMapping.ts` also decides which FORK actions a row offers, and the
  fork-before half is a harness rule, so callers rendering a real transcript
  pass `DisplayProjectionOptions.harness`: the Claude SDK cuts at the turn
  PRECEDING a prompt, so it needs an anchor strictly earlier and its first
  prompt is never offerable; pi branches from the prompt itself and needs that
  prompt's own anchor, including on a session's first prompt. Omitting the
  harness keeps the SDK rule, which is right for the anchor-blind callers (turn
  stats, message counts) and wrong for a pi transcript — it offers a fork the
  server refuses.
- `objectLinks.ts` owns generic `pa://` object-link parsing, formatting,
  canonical routes, and compact resolution types.
- `buildInfo.ts` owns `BuildInfo` — the version, commit, release-ness and
  dirtiness of ONE runtime — and the display rules for it
  (`buildVersionLabel`/`buildCommitLabel`/`formatBuildInfo`). Three runtimes
  answer this question independently (browser bundle, server, native shell), so
  the type is shared rather than per-surface, and the rules live here because
  three surfaces render them: Settings → About, a copied diagnostic, and the
  desktop About panel (which reimplements the same rules in Rust — see
  `app/shell/src/buildinfo.rs`). `release` is TRI-STATE: `false` is the claim
  "this is not the tagged release" and renders as `-dev`, while `undefined`
  means the build could not tell and must make no claim at all — a Nix build
  knows its commit but never its tags. The server's own answer rides
  `ready.serverBuild`; the browser's is a build-time define; the shell's arrives
  through `shell_info`. `docs/ci-cd.md` holds the contract.
- `memory.ts` owns the agent-memory domain contracts (kinds, lifecycle/temporal
  modes, scope, provenance, `MemoryCard`, effective-snapshot/load-audit shapes,
  learning mode, `MemorySettings`, and text/observation bounds);
  `memoryValidation.ts` owns the pure, dependency-free validators/normalizers
  (IANA timezone, text bounds + secret-like rejection, scope,
  temporal/recurrence, numeric clamps) shared by the server service, tools, API,
  and Settings. Both are re-exported from `protocol.ts`; `MemorySettings` is a
  field of `AppSettings`.
- `peerRuntimes.ts` owns the shared peer-session limits (the
  `AppSettings.sessionPeerPromptMaxHops` default 50 and bounds 1–200) and the
  approved peer-runtime contracts ([Task-595](pa://task/595)): the persisted
  `PeerSpawnRuntime` row (`AppSettings.peerSpawnRuntimes`, an ordered list
  bounded by `MAX_PEER_SPAWN_RUNTIMES`; server normalization drops only an
  unaddressable row — no id, no model id, or a duplicate id — so a half-written
  or broken approval stays visible for repair, and it REWRITES nothing: the
  thinking level is `StoredThinkingLevel`, deliberately wider than
  `ThinkingLevel`, because a stored value this build does not recognize must
  survive READABLE rather than be repaired into a valid level the human never
  selected), `peerRuntimeUnavailableReason` — the ONE rule for when an approved
  row stops being usable, covering a row that records no account or provider and
  one whose level is unknown or absent, so Settings and the agent-facing roster
  never disagree. The row also carries the user's coarse `relativeCost` label
  (`low`/`medium`/`high`/`unknown`) and an optional selection `description`
  bounded by `MAX_PEER_RUNTIME_DESCRIPTION_CHARS`; both are projected to agents
  by `session_spawn` profiles. The host infers only `PeerRuntimeFamily`, using
  `unknown` rather than guessing when a cross-family preference cannot be
  established from known provider/model conventions.
- `workflow.ts` owns the Workflow Run domain contracts
  ([Task-364](pa://task/364), `docs/agent-workflows.md`): run lifecycle and
  ceilings (`WorkflowRunSummary`: discovery passes and fix iterations, the two
  the user sets and may raise — sessions follow from them rather than being
  configured beside them), the four step kinds and their statuses
  (`WorkflowStep`, with the terminal-status sets and their predicates), the
  generic structured result (`WorkflowStepResult`: status, bounded summary,
  registered `contractId`, opaque payload), the append-only transition log
  (`WorkflowEvent` with `WorkflowActor` provenance), the composed
  `WorkflowRunDetail`, and the bounds the server enforces
  (`WORKFLOW_SUMMARY_MAX_CHARS`, `WORKFLOW_REASON_MAX_CHARS`,
  `WORKFLOW_PAYLOAD_MAX_CHARS` — prose truncates, structured payloads are
  refused), plus the run-limit seams — the start-sheet bounds
  (`WORKFLOW_RUN_LIMIT_BOUNDS`, applied by
  `applyWorkflowRunLimits`/`normalizeWorkflowRunLimits`, whose maxima are typo
  guardrails on that form only) and the ceiling-gate raise
  (`raiseWorkflowRunLimits`, floored at each limit's minimum but never capped:
  the gate is the user's explicit decision to let a run continue) — and the
  run's opaque write-once `config`. It is re-exported from `protocol.ts`, which
  adds the `workflow` broadcast topic and `workflowRunList` snapshot/broadcast.
  The list includes recipe-owned `WorkflowRunCard` projections for non-terminal
  runs; that type lives beside
  `WorkflowRoleConfig`/`WorkflowRoleCandidate`/`CodeDeliveryWorkflowConfig` in
  `protocol.ts` because naming role sessions, review commits and assessment
  findings would make the generic core model recipe-specific. That section also
  owns the four candidate-set bounds, the per-run early-push/CI timeout and poll
  settings (`WORKFLOW_CI_DEFAULTS`/`WORKFLOW_CI_BOUNDS`), the card's session
  links, its `reviewSet` rollup, the decision the run CARRIED OUT (read from the
  step that followed it, never from the answer), and the open ceiling gate with
  the choices it can actually carry out. A `ReviewFinding` may carry the
  `path`/`line` it is about and the `commentId` of the durable thread the server
  published it as; `ReviewFindingResolution` is the read-back state of one such
  thread (`resolved`, `disputed`, `open`), which the fix round records and the
  author's re-check, the verdict pass and the card consume. The same wire
  section owns
  `pauseWorkflowRun`/`resumeWorkflowRun`/`cancelWorkflowRun`/`retryWorkflowRun`,
  `deleteWorkflowRun` (cancelled runs only, with explicit worktree-delete and
  session-archive booleans), `answerWorkflowCeiling` (raise to stated ceilings,
  deliver as it stands, re-evaluate — look at the workspace again once the user
  has fixed it — or cancel; `deliver` is the only route by which work no
  discovery review passed may ship, and `re-evaluate` is what a gate offers in
  its place when the delivery attempt itself is what found no head — only a
  fresh look at the workspace can answer differently), and the run-start shapes
  ([Task-366](pa://task/366)): the `WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS` bound
  (rejected, not truncated), the `startWorkflowRun` client command, and the
  `workflowRunStart` phase reply (`WorkflowRunStartPhase`) keyed by `requestId`.
  Deliberately GENERIC: a step is a kind plus an opaque payload, and no type
  here names an implementer, reviewer, commit, or pull request — recipe meaning
  lives in payloads and registered result contracts.
- `skills.ts` owns the user-owned skills library wire model
  ([Task-531](pa://task/531), `docs/skills.md`): `SkillSummary` (declared name,
  description, library-relative `SKILL.md` path), `SkillDiagnostic` with its
  `SkillDiagnosticCode` vocabulary, and the `SkillLibraryList` read model that
  carries both halves plus the absolute `libraryPath` the user maintains by
  hand. Summaries stay compact because the list view shows all of them at once,
  and diagnostics travel WITH them because a malformed folder is what a
  hand-authored library actually produces — it is listed with its reason rather
  than dropped. A diagnostic identifies its SOURCE FOLDER, which is independent
  of any name that folder declares. The server scanner builds these types
  directly (`skills/skillLibraryScanner.ts`), so browse and injection cannot
  read two different shapes. It is re-exported from `protocol.ts`, which adds
  the `skills` broadcast topic and the single `skillList` message: exactly one
  of `list`/`error` is set, and a failed scan is an `error` rather than an empty
  library. It also owns the two rules the library and its settings must agree on
  ([Task-613](pa://task/613)): `isSafeSkillName` (with `MAX_SKILL_NAME_CHARS`),
  the one definition of a declared name, used by the scanner AND by settings
  normalization so a name that can be scanned is a name that can be toggled; and
  `SkillToggles` with `isSkillEnabled`, the read rule for `AppSettings.skills`.
  That map is sparse and keyed by declared NAME — the thing a session freezes
  and a runtime layout materializes, not the source folder — and only an
  explicit `"on"` enables: absence, `"off"`, an empty section and settings not
  yet fetched all answer off, so no missing read can enable a skill. The
  single-skill read ([Task-614](pa://task/614)) is the same shape one level
  down: `SkillDetailResponse` is `SkillDetail` (the summary's metadata plus the
  `SKILL.md` body below the frontmatter, the file's `bytes`, and `truncated`
  against `MAX_SKILL_BODY_BYTES`) or `SkillDetailUnavailable`, an explicit
  invalid state carrying the requested name and the reason. A valid detail also
  carries `SkillFileTree`: recursive `SkillFileTreeEntry` nodes with entry,
  depth, and UTF-8 metadata-byte bounds plus reached-limit and race diagnostics.
  `SkillFilePreviewResponse` is the bounded HTTP text-viewer union: decoded text
  with full size/truncation, or explicit binary metadata. The same module owns
  the tree/preview/raw byte constants so server and web state the same bounds.
  Both detail kinds echo the requested NAME because an unavailable answer is
  what the scan/read race produces, so it is a normal answer rather than an
  error status.
- `knowledgeBase.ts` owns compact first-class KB UI/API types shared by server
  and web: entry/tree/inspector payloads. `KnowledgeDiffPreview` carries both
  the raw `git show` patch and structured per-file old/new text
  (`KnowledgeDiffFile`, bounded, binary/truncation-flagged) so the history
  inspector can render a rich pierre diff and a rendered-Markdown diff.
  `KnowledgeHistoryRow.commentThreadId` (from the commit's `KB-Comment` trailer)
  links a content edit back to the review thread it addressed.
- `comments.ts` owns the cross-surface comment anchor vocabulary:
  `CommentTarget` (kb / worktree / session / task), the `SelectorBundle` of
  quote, position and block selectors, the `ResolvedAnchor` a resolver answers
  with, the shared 32-character `PREFIX_LEN`/`SUFFIX_LEN`, and
  `normalizeAnchorText` — which is a COMPARISON helper only, since stored
  selectors keep raw text and every offset is into the raw document. Contract:
  `docs/comments.md`.
- `usage.ts` owns the Usage page's provider account usage/rate-limit snapshot
  types (`ClaudeUsageSnapshot`, `OpenAiUsageSnapshot`). Each is a deliberately
  small, stable projection over an unstable upstream: Claude's experimental
  `usage_EXPERIMENTAL_…` control response, and OpenAI's ChatGPT
  `/backend-api/wham/usage` response. OpenAI windows are classified by duration
  (`kind`), never by the raw primary/secondary field names; its `spendControl`
  carries no currency (raw numbers, likely USD).
- `usage.ts` also owns the narrow `UsageIndicator` projection the provider cards
  render (profile id, provider, `short`/`long` cycle windows, `limitsAvailable`,
  `refreshing`, `fetchedAt`) and the display helpers both surfaces share:
  `usageLevel` (green < 70, amber 70–90, red ≥ 90), `USAGE_STALE_MS` /
  `USAGE_HARD_INVALID_MS`, `usageIndicatorState` and `usageWindowPct`. The
  indicator carries FACTS, not a computed freshness verdict: readers derive
  staleness from `fetchedAt` on their own clock, so a card degrades even when
  nothing pushes (an account in failure backoff would otherwise keep claiming to
  be fresh), and `usageWindowPct` drops a percent whose window already rolled
  over. Account email, spend control and credit detail deliberately stay out of
  this projection. See `docs/usage.md`.
- `protocol.ts` owns the optimistic-mutation correlation contract:
  `MUTATION_REQUEST_ID_COMMANDS` names the commands that carry an optional
  `requestId`, and the server answers each with either an `error` carrying that
  id or a `mutationSettled`. It exists because these domains ALSO broadcast
  unsolicited authoritative state, so "the next list that arrives" cannot tell a
  client whether its own change succeeded. The pending client entry retains
  touched object ids and a create's browser-local temp id; rejection recovers
  those objects authoritatively rather than restoring an inverse over a
  concurrent write.
- `StateEvent`/`StateEventsMessage` are the shared domain-delta envelope: one
  `seq` per atomic flush and one revision per upsert/delete. Revisions are
  envelope metadata, never fields on the summary item; the browser keeps them in
  a per-topic, per-object sidecar so a matching optimistic row retains identity
  when the authoritative echo arrives. Tasks are the first MIGRATED domain:
  their mutations travel only as events, `taskList` remains as the subscribe/
  resync answer (carrying the `seq` baseline the gap tripwire compares against),
  `taskSaved` carries the full item plus the `requestId` that settles a create's
  temp row, and `taskProjectsAssigned` is a bare acknowledgement. Projects use
  the same envelope with `ProjectSummary`, archived-inclusive membership,
  revision sidecars/digests, and correlated `projectDetail` full-document reads.
  The summary keeps only two path-derived facts: normalized `primaryPath` for
  legacy path-prefix hierarchy and `hasRepoPath` for pre-worktree eligibility;
  full path records and their notes remain detail-only.
- `taskSummaryOf` and `projectSummaryOf` live in `protocol.ts` because BOTH
  sides project: the server builds every list item and event with it, and the
  browser settles an optimistic create against `taskSaved`'s full item with it.
  A second, hand-written narrowing in the client would put `description` into
  the list and make the echo of a row the client itself projected compare
  unequal.
- `protocol.ts` owns `BroadcastTopic`/`BROADCAST_TOPICS` and the
  `subscribe`/`unsubscribe` client commands: the single session socket's domain
  LISTS (`tasks`, `projects`, `subagents`, `background`, `worktrees`,
  `knowledge`, `calendar`, `usage`, `workflow`, `skills`) are fanned out per
  subscribed connection rather than to everyone, and subscribing to a stateful
  list is also the authoritative read — which is why `ready` carries no
  `taskList`. Held subagent thread detail is a separate authorized
  per-connection topic with bounded snapshots and revisioned run events. The
  session list is deliberately NOT a topic (every surface's sidebar shows it),
  and neither are per-object streams (worktree status/changes, comment traces),
  which are addressed by the object a connection has open.
- The first production socket frame is `webBuild` (and `ready.webBuildId`
  repeats it): it identifies the browser bundle currently served with the
  server. A production client remembers the id and reloads when it changes
  across a reconnect, before consuming a newer snapshot/event shape, so an
  already-open pre-deploy JS client cannot continue speaking an obsolete
  protocol to a newly deployed server.
- `protocol.ts` splits Task payloads by weight, and the types enforce it.
  `TaskListResponse.items` is `TaskSummary[]` — no list payload carries a
  Markdown body. Its `sessionRefs` are `TaskSummarySessionRef[]`, limited to the
  client-used `sessionId` and `origin`; engine/persona, attachment time and the
  server's transcript path exist only on `TaskItem` detail refs. `TaskItem`
  (from request-correlated `getTask` → `taskDetail`, and `taskSaved`) is the
  only shape carrying `description`, so a surface that renders the body fetches
  the Task itself. `taskDetail.item: null` without `error` is authoritative
  not-found; a failed read carries `error`, and the echoed `requestId` lets the
  browser reject superseded same-id answers.
- `TaskExternalLinkSource` is a closed provider set
  (`slack`/`jira`/`github`/`forgejo`/`unknown`). Every member but `forgejo` is
  recognized from the URL alone; a self-hosted Forgejo has no fixed host, so
  both classifiers call the shared `isForgejoInstanceUrl(url, baseUrl)` —
  `tasks.ts` passing `getForgejoBaseUrl()`, the web twin
  (`TaskContextSections.detectLinkSource`) taking the base URL as an argument
  from `settings.forgejo.baseUrl`. That predicate compares host AND port and
  requires the base URL's path as a prefix when it has one (protocol is
  ignored), so an instance at `http://localhost:3000` cannot swallow every
  `localhost` link. Without a configured instance the link stays `unknown`
  rather than being guessed, and since `tasks.ts` re-detects any stored
  `unknown` on read, a link added before the instance was configured
  reclassifies itself later — no migration. `isTaskExternalLinkSource` is the
  matching runtime guard, used by both server coercion sites so a new provider
  is added in one place.
- `protocol.ts` also owns Jira projections: compact
  `JiraLinkedIssue`/`JiraLinkedIssuesResponse` enrich stored Task keys without
  persisting duplicate summaries, while `JiraIssueMutationItemDisplay` carries
  approval-safe create/edit/comment/rank details (including a new issue's
  Markdown source, parent, fields, native links, result key, and non-fatal
  partial-execution warning). A rank item carries the issues in their requested
  order, the resolved anchor, the bounded `JiraIssueRankScopeDisplay` a
  top/bottom was read from, the chained `JiraIssueRankStepDisplay` calls with
  their per-step outcome, and the ordering observed afterwards.
  `WebPushConfigResponse` and `WebPushSubscriptionInput` expose only the public
  VAPID key and browser subscription capability fields needed for
  installation-scoped Declarative Web Push (never the private key).
- `protocol.ts` keeps one `ApprovalKind`/`ApprovalBody` union per mutation
  family. `gmailArchive` freezes each approved message id with the sender,
  subject, thread id, and Gmail link, so the card and executor use the same
  bounded set even if more mail arrives. `GoogleSettings.gmailArchiveAuthorized`
  exposes whether the server recorded the required grant, without exposing
  tokens or raw credential state. The two pull-request providers are SEPARATE
  kinds (`githubPullRequest`, `forgejoPullRequest`) rather than one
  provider-generic kind: cards persisted in the `approvals` table carry the kind
  string, so collapsing them would make existing cards unreadable. The Forgejo
  shapes also encode that instance's real contract — `ForgejoPrReviewEvent` is
  `APPROVED`/`COMMENT`/`REQUEST_CHANGES` (not GitHub's
  `APPROVE`/`CHANGES_REQUESTED`), `draft` is documented as the `WIP: ` title
  prefix because the API has no draft field, `ForgejoPrInlineCommentDisplay`'s
  `side` is a display choice translated to `new_position`/`old_position`, and a
  reply is `replyToReviewId` + a `replyPath`/`replyLine` anchor because Forgejo
  comments on a REVIEW rather than on another comment. The overlapping display
  fields are structurally identical, which is what lets one web card body render
  both. Both PR mutation vocabularies have a `ready` arm carrying the PR number;
  approval executes a draft-to-reviewable transition, not a merge.
  `GithubPrMutationOperation` also has an `assign` arm the Forgejo one lacks,
  carrying six add/remove lists: review requests
  (`addReviewers`/`removeReviewers`, plus org team slugs in
  `addReviewerTeams`/`removeReviewerTeams`) and issue-level
  `addAssignees`/`removeAssignees` are independent lists on the same pull
  request, and an absent one means that list is left alone.
  `ForgejoReleaseApprovalBody` is a third Forgejo kind rather than an arm of the
  PR one: it carries a `targetSha` — a RESOLVED commit, with `targetRef` and
  `targetSubject` only naming what that sha was — because the user approves a
  revision, not a branch that may move before the card is answered.
  `SessionSpawnApprovalBody` is the one EDITABLE body: its items carry RESOLVED
  runtime values (provider, model, account, thinking) rather than the agent's
  raw hint, plus a `modelWarning` naming what did not survive resolution, and
  the user's changes travel as `ApprovalResolutionEdits` on the
  `resolveApproval` message rather than as a prior patch to the card. That split
  is deliberate: the stored card stays the agent's proposal — readable as such
  after a reload — and applying the edits is part of the one atomic approval.
  `validateClientMessage.ts` checks only their SHAPE; whether an account may run
  the named model is the executor's `prepare` decision, because only it can
  refuse while leaving the card pending. `ManagedPullRequestMergeApprovalBody`
  is the provider-neutral kind behind the one managed-delivery step that is
  never pre-authorized: an agent merging its own managed pull request into the
  repository's DEFAULT branch. It carries frozen decision evidence —
  worktree/project/repository/provider, number/url/ title, head → base, the
  provider-reported default branch, the exact accepted head SHA, the requested
  method with the currently supported set, the branch-deletion choice, the
  exact-head check summary, hosted review, mergeability/draft state and the
  linked Task — as a record of what was decided, never as facts execution may
  trust: approving re-derives all of them and refuses on any drift.
- `session/` owns provider-neutral normalized session content, entries,
  snapshots, origins, and config. A system origin may carry a typed
  background-work presentation for the browser; it contains compact task facts
  and authenticated artifact URLs, never the model-only local path or output
  body.

## Contract notes and rationale

- Keep this package runtime-light and safe for both Node and browser consumers.
- Avoid importing server-only or React-only modules.
- Keep shared `pa://` object-link helpers runtime-light; resolution data is
  compact metadata and full object reads stay in domain-specific server/web
  surfaces.
- A Task's status is the USER's call, and the protocol says so (the product
  contract behind these shapes is `docs/tasks.md`):
  `TaskSummary.statusSuggestion` is an AGENT's statement about where the Task
  should stand — `to: "done"` (finished) or `to: "todo"` (handed back
  unfinished), with an optional one-line `reason` — recorded INSTEAD of writing
  the status, and `TaskSaveRequest.clearStatusSuggestion` is the dismissal. An
  agent's "done" is a report rather than evidence — eagerly-completed Tasks used
  to vanish from every open list with the work unfinished — so the Task keeps
  its real status until the user answers. There is no third value: saying
  nothing means "leave it in doing". Rejecting needs its own flag because it
  changes no other field, and an ordinary save must never silently discard a
  pending suggestion. `TaskSaveRequest.title` is therefore optional on an UPDATE
  (required only on a create): the surfaces that answer a suggestion include a
  recorded transcript Task card whose title is frozen at mutation time, and a
  save that echoed it back would rename a Task renamed since. Omitting the field
  leaves the stored title alone; sending a blank one is refused.
- `TaskSummary.triagedAt` is when the USER processed a Task that arrived on its
  own (meeting minutes, Slack intake, an agent noticing work); unset means it is
  still in the Backlog's Inbox. `TaskSaveRequest.triaged` is the explicit
  dismiss/restore, needed because rejecting or accepting an arrival changes no
  other field.
- `archiveTask` carries the DIRECTION (`archived`, defaulted to `true` by
  `connection.ts`), mirroring `archiveSession`. The browser offers archiving
  without a confirmation prompt precisely because the receipt's Undo is the same
  message with `archived: false`; a one-way command left the app with no way
  back at all, since there is no archived-Tasks view. What may be archived is a
  product rule and lives in `docs/tasks.md`, not on the wire.
- `appNotification` is the one ADVISORY `ServerMessage`: it carries no state, is
  never replayed, and a client offline for it has simply missed it. It exists
  because Web Push cannot reach a runtime with no push service — the native
  shell is a WKWebView, where `PushManager` does not exist and a subscription
  can never be made — so the server sends the same payload over the live socket
  as well and lets the client decide. Exactly one runtime acts on it: a browser
  is already subscribed for the same alert, and acting on both notifies twice.
- Any protocol change must be reflected in server producers/validators and web
  reducers/renderers. Knowledge entry and document comments never reach the
  wire: they are browser-local until sent as prompt prose (`docs/comments.md`).
  Task activity-trace comments (`TaskComment`) use validated, request-correlated
  `listTaskComments`/`addTaskComment` commands, an explicit
  `unwatchTaskComments` lifecycle, and authoritative `taskComments` full-list
  broadcasts; direct read answers echo `requestId`, while broadcasts to other
  viewers do not. `TaskSummary.commentCount` is the list badge. Integration
  settings projections must remain minimal and secret-free; Slack's browser
  state carries only the booleans required by its end-user settings surfaces.
- Viewed-chat run state belongs in runtime snapshots/events; `SessionState` must
  remain session metadata and must not carry a working-indicator field.
  `SessionState.activeSkills` is session metadata: coding personas carry the
  stored frozen library-skill names, including an empty list, while non-coding
  personas omit it. State projection is read-only and never freezes settings.
  `SessionState.skillInvocations` (`SessionSkillInvocation`: `at`, declared
  `name`, `via: "skill_tool" | "read"`) travels with it and records the loads
  the transcript actually made; a frozen name alone is availability, not
  context.
- `SessionMode` ([Task-329](pa://task/329)) is how much a session may CHANGE, a
  third session axis beside harness/persona and model/thinking: `build` is the
  ordinary session, `plan` subtracts file-mutating native tools and app tools
  classified with local/external side effects, except `task_manage` for durable
  Task organization and `session_spawn` for read-only profile inspection; that
  tool still refuses `spawn`/`propose` against persisted Plan mode. Reads,
  search, shell, and read-only `mcp__pa__*` tools remain. It is the only one of
  those axes that is NOT frozen by the first prompt — `setSessionMode` is
  accepted at any point and takes effect on the next turn — so `SessionState`
  reports it as live state (an absent legacy value behaves as `build`).
  `newSession`/`harnessSend` carry an optional starting `mode`; both interactive
  harnesses consume it, and the server's persisted mode always wins on reopen.
  Which side ENFORCES it is a harness contract, not a wire one: the wire says
  which mode a session is in, never which tools that removes.
- Preserve backwards-compatible persisted type readers unless old runtime data
  is intentionally migrated or explicitly dropped under the repo's
  no-back-compat cleanup rule.
- Keep provider capability flags additive on protocol/session types so older
  clients can ignore them safely.
- Preserve assistant `stopReason` markers through protocol/display projections
  when a partial turn is durably retained.

## Working notes

- Prefer additive protocol evolution and explicit discriminated unions.
- Keep display projection deterministic; server reconnect snapshots and web
  reducers should render the same result.

## Verification commands

- Run `pnpm --filter @assistant/shared test` for this package's own tests
  (Vitest; wired into the root `pnpm run test`). The display projection is
  covered directly here — it is the one piece of shared logic that decides what
  the user actually sees, so shape rules AND object-identity guarantees belong
  in this package rather than being inferred from server/web suites.
- Run `pnpm --filter @assistant/shared typecheck` for shared-only changes.
- Run root `pnpm run typecheck` when server/web consumers are affected.
- Run root `pnpm run build` before closeout.
