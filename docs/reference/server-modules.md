# Server modules — implementation reference

Relocated from `app/server/src/CLAUDE.md` (Task-274) so it stops costing agent
context on every visit. This is a descriptive snapshot of what the modules in
that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Server implementation modules for session lifecycle, WebSocket commands, HTTP
APIs, agent/tool integrations, settings, tasks and persistence.

## Module ownership

- `index.ts` owns HTTP routing, static serving, auth gating, WebSocket upgrade
  setup, and graceful process shutdown (stop accepting new work, drain active
  sessions, then exit through cleanup hooks). Three WebSocket surfaces share the
  HTTP server — the session protocol on `/ws`, dictation audio on `/ws/speech`,
  and the official Claude CLI login terminal on `/ws/claude-login` — and ALL
  must be `noServer: true` behind the single `server.on("upgrade")` router that
  applies the origin/token/shutdown gate once: constructing them with
  `{ server, path }` attaches independent upgrade listeners, each calling
  `handleUpgrade` unconditionally, and the one whose `path` does not match
  aborts the handshake with 400 before the right one is reached.
  `permessage-deflate` stays on the session socket only (the other two are short
  control/terminal frames or incompressible PCM).
- `connection.ts` owns one browser WebSocket connection and translates client
  commands into server operations. EVERY command dispatches inside a
  `MutationScope`, whose two jobs are separable: recording THAT a command
  failed, and — for a command carrying a `requestId`
  (`MUTATION_REQUEST_ID_COMMANDS`) — stamping that id onto the failure. A
  correlated command is answered exactly once: every `error` a handler sends
  while one is in flight is stamped with that id, and a command that produced
  none settles with `mutationSettled`. Handlers stay unaware of it, so a new
  optimistic command only has to carry the field. The scope is opened for
  UNCORRELATED commands too, even though they have no id to stamp and no settle
  to send, because handlers report failure by SENDING an error rather than
  throwing — so anything that reads the outcome (Task triage) would otherwise
  treat a refusal as a success, which is exactly what let a refused command
  process a Task out of the Inbox. That scope is an `AsyncLocalStorage` entry,
  NOT a field on the connection: the socket does not await `handle`, so
  correlated commands interleave and a saved-and-restored field lets one command
  clear another's id — leaving a failure unstamped and then also reported as
  settled. The scope records its connection too, since a mutation can
  synchronously drive sends to other connections through the hub. Alongside that
  id, a failure carries the OBJECT it is about (`MessageTarget`) wherever the
  handler holds an unambiguous one — its own `id` parameter, or a local captured
  before the first `await`, never `this.viewing` read in a `catch`, which names
  whatever the user navigated to while a slow write failed. A comment write
  names the object the thread is ON (`messageTargetForComment`), an act spanning
  many objects (reorder, bulk assignment) names none, and a list read that fails
  names its COLLECTION (`{ type }` with no id). `docs/messaging.md` owns where
  each of those then renders. Runtime-backed viewing splits chat events onto
  `RuntimeTransport`, while its engine-viewer bridge forwards non-chat metadata
  plus session-scoped store-backed overlay lifecycles (`approvalUpdate`,
  `peerPromptCardUpdate`); targeted hub broadcasts enter through that bridge, so
  omitting an overlay type leaves live cards stale until reconnect. VIEWING a
  session marks it read on a DWELL, not on arrival (`armReadDwell`,
  `@assistant/shared`'s `SESSION_READ_DWELL_MS`): both the deep-linked initial
  view and `loadSession` arm one timer, viewing anything else or closing the
  socket disarms it, and only a session still open when it fires is marked read
  and broadcast. Clearing "unread" the instant a card is clicked re-sorted the
  Sessions inbox out from under that click, and a session opened by mistake
  should still be waiting afterwards. Read marks that follow an ACTION — sending
  a prompt, answering a question — stay immediate, since the action already says
  it was read. Viewing is LATEST-REQUEST-WINS ([Task-697](pa://task/697)):
  socket messages are handled concurrently and `loadSession` acquires its
  session asynchronously, so in a rapid A→B→A a slow B acquisition can complete
  last; a view request claims a ticket (`viewRequestSeq`) before it awaits and
  attaches only if no newer intent — another request, a session created or
  forked and viewed synchronously (`view()` claims too), a `clearSessionView`,
  or `dispose()` — has claimed one since. That covers the deep link too: `init`
  claims before `initialView` acquires, because a client whose sidebar painted
  from its shell cache sends `loadSession` before `ready`, and that newer
  navigation must win over a slow reopen. Every handler that creates, forks,
  reopens or hands off to a session (new session, both harnesses' first send,
  draft, fork, the post-reload continuation, the comment handoffs, the calendar
  day) claims at the point it commits to viewing — before its first await — and
  attaches through `viewIfCurrent`, so intent order is ARRIVAL order, never
  completion order (the claim goes ahead of the model lookup and the worktree
  resolution too — any await ahead of it is a window in which a newer load
  completes and the older operation would take the view back; `viewIfCurrent`'s
  doc is the rule, `sessionCreateRace.test.ts` holds those awaits open against a
  newer load); the session is still created (and a first send's prompt still
  runs) when a newer navigation keeps the view, but no route message tries to
  move the client to it. A claim follows synchronous validation, so an invalid
  or guarded request (a bad calendar date) cancels nothing. A claim names the
  session it is for when its claimant knows it (`viewRequestTarget`: a load, the
  deep link, a send into an existing session, every attach; a creation or fork
  names none). A LEAVE — deleting or archiving a session — supersedes only a
  newest claim for THAT session, on show or still acquiring: the attach itself,
  a reload of it (the client's snapshot fallback), or a cold load of it from
  another session, any of which would otherwise bring back what was just
  archived or deleted; otherwise `clearSessionView` only detaches, so a load of
  another session that arrived before OR during the delete's blocker check keeps
  its claim and attaches when it completes, and a delete refused for background
  work claims nothing at all. The client is told (`sessionViewCleared`, with its
  `reason`) whether the session was on show or only loading, so a route naming
  it can leave. Deletion is HUB-WIDE (`hub.clearSessionViews`): every registered
  connection viewing or loading the session leaves it in the same synchronous
  run as the tombstone and eviction, before the shared driver is disposed — a
  viewer left on it would keep routing commands into it — while archiving is per
  connection, since an archived session can still be viewed on purpose (a later
  deliberate open is a new claim). `ready` gathers what it awaits first and
  captures `state` and `contextInfo` together, so they describe the session the
  client's snapshot holds. `dispose` claims and `view` refuses after disposal,
  so a load completing after the socket closed attaches no ghost transport or
  viewer (a pi session's idle eviction and read marks key off its viewers); on
  the pi side `piStore.track` arms the zero-view idle clock on registration, so
  an acquisition nobody ends up viewing is evicted like any idle session,
  concurrent reopens of one session share one open, and a cold reopen the delete
  beat to registration (record tombstoned, `evict` found nothing yet) is refused
  at the ownership boundary: nothing is tracked, what `create` built is disposed
  at once, and every owner sharing the open gets `PiSessionDeletedError` — which
  `hub.acquireById` answers as "no such session" (`piOwnership.test.ts`). A
  server-initiated navigation (`permanentAssistantOpened`, `draftSession`,
  `forkedSession`) gathers what its route message needs BEFORE attaching, so the
  snapshot and the message that moves the client to it leave back to back — the
  client relies on that ordering instead of second-guessing snapshots — and
  re-validates its ticket after the list read (`sessionViewRace.test.ts` drives
  the acquisitions in every completion order, through close and a load landing
  in the list-read gap). A `loadTimelineBlock` that cannot be answered is failed
  BY NAME (`timelineBlockFailed`: the block's identity plus `unavailable` or
  `error`) ahead of the user-facing notice, so the client can retire that read.
  Session rows leave through ONE wire projection (`publicServerMessage`),
  applied structurally to ANY message carrying them rather than to an enumerated
  list of message types: it strips the server-internal provider-native `file`
  handle and drops the rows no ordinary list may show (the singleton Personal
  Assistant), and a one-row `sessionUpdated` about a hidden session is not sent
  at all. Enumerating types is what let `permanentAssistantOpened` answer an
  open with the unfiltered list and put the singleton back in the sidebar.
- `hub.ts` broadcasts a session-list rebuild as single-row `sessionUpdated`s
  whenever only volatile row state moved (running, unread, title, `updatedAt`) —
  which is what almost every rebuild during a run is — and as the full
  `sessions` list only when the SET of rows changed, when more than
  `SESSION_DELTA_MAX_ROWS` moved, or on connect. `sessionListDelta` decides, per
  archived-variant, by comparing the rows it just built against the last ones it
  sent; a client's upsert is idempotent and re-sorts, so a delta is safe to
  apply whatever that client last saw, and anything a single-row upsert cannot
  express forces the list: an added, removed or archived session, and a changed
  `archivedSessionCount` — which travels only on a full list and can move while
  a variant's own row set does not (restoring a session for an archived-loaded
  client, deleting an archived one for everyone else). The full list is ~30 KB
  against production data, sent up to ~4 times a second to every connection.
- `hub.ts` owns the harness-neutral live-session registry: merged
  listing/broadcast, restore dispatch, dev/deploy restart draining, and
  session-driver lookup. Which engine holds a session is the harness registry's
  to answer (`harnesses/registry.ts`); per-harness lifecycle lives in `piSdk/`
  and `claudeSdk/`. The hub creates, forks, renames and removes no session:
  `harnesses/create.ts`, `harnesses/fork.ts` and the registry do. Git state
  lives with worktrees (`worktrees/`), not the hub.
- `harness.ts` owns the harness-neutral driver interfaces (`Viewer`,
  `HarnessDriver`, `LiveSession` with its `isLiveSession` guard) shared by both
  harnesses.
- `harnesses/` is the seam between app code and the two engines
  (`docs/agent-harnesses.md`): `oneShot.ts` (`runOneShot`, every helper run),
  `models.ts` (picker and per-account model lists, exact availability, stored
  session model display, pi model handles for creation), `curatedModels.ts` (the
  Claude curated options and aliases, loading no engine SDK), `boot.ts` (engine
  runtime setup the server boot starts), `storage.ts` (where each engine keeps a
  session on disk, from paths alone), `availability.ts` (whether an existing
  session may be opened now), `toolExposure.ts` and `piSession.ts` (pi's tool
  exposure and session types), `usage.ts` (per-account usage, OpenAI
  reset-credit redeem), `registry.ts` (`harnessRegistry`: id routing, resident
  sessions, store wiring, rename and the engine half of a delete),
  `firstSend.ts` (each engine's admission and preparation for a session's first
  send), `create.ts` (`createSession`: each engine's creation sequence) and
  `fork.ts` (`prepareFork`: each engine's fork cut and refusals).
  `harnessBoundary.test.ts` pins what still bypasses it.
- `sessionKit/` holds what both engine session classes compose instead of
  copying: `residency.ts` (`SessionResidency`, the viewer set and the idle clock
  that lets the owning store release an unviewed, idle session) and
  `hostCommandTurn.ts` (the emission of a synthetic host-command turn and its
  card, `HostCommandResult`).
- `agentTypes.ts` owns the persona registry (`AGENT_TYPES`): system prompts and
  the per-persona `AgentTool` toolsets, independent of harness. Toolset
  COMPOSITION lives in the tool catalog (`tools/catalog.ts`): persona toolsets
  are the flat union of `ToolGroup`s carrying eager/deferred loading tiers, the
  integration family, and integration gates. Personas are `assistant`,
  `workshop`, `developer`, and the server-owned `personal-assistant` and
  `workflow-coordinator` personas. `isAgentAvailable`/`availableAgents` exclude
  both server-owned personas from ordinary creation while
  `isAgentSessionAvailable` keeps their existing sessions loadable. The
  `personal-assistant` persona shares the ordinary Assistant's integration-tool
  universe but owns separate behavior guidance (`personal-assistant.md`) and
  always receives the permanent profile suffix; it is created ONLY by the
  server-owned singleton acquisition path (`permanentAssistant.ts`). Every
  ordinary client creation path
  (`newSession`/`harnessSend`/`createDraftSession`) rejects a crafted persona
  key via `guardKind` (pi) or `isOrdinarilyCreatableAgentType` (claude-sdk).
  `tools/workshop/worktreeDeliveryTools.ts` exposes deferred Build-only
  `worktree_commit`, `worktree_push`, `worktree_create_pull_request`, and (from
  `worktreeFinishPullRequest.ts`) `worktree_ready_pull_request` and
  `worktree_finish_pull_request` tools for active registered spawned worktrees;
  the derivations they share — local state, push target, remote head, hosted
  repository identity — live in `managedDeliveryTargets.ts`, because a second
  derivation of "the remote head" or "the provider repository" is a second
  chance to target something the caller never asked for. All derive their
  targets from the row and take a caller-aware mutation reservation. Commit runs
  the shared checked workflow without force; the calling session's prompts,
  touched paths and Tasks remain context and its result is the ordinary rich
  `CommitDisplay`. Push requires a clean complete HEAD and calls
  `pushWorkflow.ts` with server-derived branch/HEAD/remote preconditions.
  Intentional rewritten history uses an authoritative remote oid and explicit
  `--force-with-lease=<derived-ref>:<oid>`, never raw or bare force. Managed PR
  creation then requires that exact HEAD on a same-named upstream, binds hosting
  to the derived remote's push repository, resolves Task context from the target
  worktree, and calls the canonical `prWorkflow.ts` card service with the caller
  timeline plus trusted target worktree. Existing PR adoption is exact on
  head/base/SHA; create/read movement lands as a visible stale-head warning and
  partial success rather than a hidden external side effect.
  `worktree_ready_pull_request` publishes a matching open managed draft after a
  fresh identity read under the per-PR mutation lock, updates its cards, and
  schedules the watcher. `worktree_finish_pull_request` closes that loop: it
  resolves the row's ONE open pull request, re-reads provider detail and
  repository capabilities, and either closes it directly with a required bounded
  `reason` (through `pullRequestClose.ts`, keeping branch, worktree and Task) or
  merges it. A merge additionally proves clean local state, a same-named
  upstream and remote head equal to both local HEAD and the PR head, re-runs the
  shared readiness read from `tools/pullRequestCheckWatch.ts`, requires a
  currently supported method, and classifies the base by exact equality with the
  provider-reported default branch: a non-default base merges directly through
  `mergePullRequestAndProject`, while the default branch stages one
  `managedPullRequestMerge` approval and ends the turn without any provider
  merge. That approval's executor re-derives the complete state under a fresh
  worktree reservation and refuses on any drift. The bundled Claude Code CLI
  hard-blocks native agent `git push`, so both the checked tool and human
  `/push` run git app-side. `/commit` and free-form `/push` remain human
  convenience surfaces; `/push` retains its existing remote/ref and guarded
  bare-lease behavior. It resolves a missing upstream for both implicit and
  explicit remote first-push forms and renders a durable push-result card
  (`PushDisplay`) through the same synthetic-host-command path as `/commit`
  (`finishSyntheticCard` on both harnesses → `command.result` timeline entry).
  `prWorkflow.ts` composes those workflows for `/pr`: clean and up-to-date
  phases stay silent, a blocked commit stops the chain, and the final phase
  resolves `gitHosting.ts` directly from the repo so unregistered checkouts work
  too. `prAgent.ts` is the dedicated no-tool JSON title/body writer. The
  pull-request phase itself is store-driven (stage 2, Task 323):
  `pullRequestCards.ts` (modeled on `pendingApprovals.ts`) persists a
  `PullRequestCard`, injects it into session snapshots like an approval
  (`withPullRequestCardBlocks`), and broadcasts `pullRequestCardUpdate` on every
  change, so `/pr`'s synthetic tool turn only ever finishes with plain text. It
  also owns the session-LIST projection of those cards
  (`pullRequestSummariesBySession`: one card per session, the newest still
  moving, narrowed to `SessionPullRequestSummary`; memoized, and dropped
  directly by `writeStore` — the file stamp it is keyed on is only a backstop
  for an out-of-band `DATA_DIR` edit) and asks for a session-list broadcast
  alongside a card update that CHANGED that session's row — the summary AND the
  Task-pick block, since answering a card the row does not state still moves the
  attention badge: the card update reaches only that session's viewers, nothing
  else moves when CI turns red elsewhere, and the watcher re-patches an open
  card on every poll whether or not anything moved. Several qualifying linked
  Tasks pause the card at `choosing-task` (`taskCandidates`) until
  `resolvePullRequestCardTask` answers it and `finalizePullRequestCard`
  drafts/creates against the chosen one (or none). That pause is human-blocking
  work, so it drives the session attention indicator on the approval seam's
  shape (Task 327): `hasChoosingTaskCard` / `choosingTaskSessionIds` (both off
  the memoized index) plus `subscribeChoosingTaskCardChanges`, which fires only
  when a session's answer changes so the watcher's routine patches do not
  rebroadcast state. Both harnesses fold it into `idleReason`
  (`awaiting_task_choice`) and the list states it as `attention: "task-choice"`;
  an unanswered prompt counts even when a newer card has taken over the row.
  `pullRequestWatcher.ts` is the adaptive, viewer-independent poller that keeps
  an `open` card's CI/review/mergeability current via `gitHosting.ts`'s
  `pullRequestDetail`, sends a deduped (per PR + head SHA) CI-conclusion alert,
  and is reconciled on boot like `reconcileWorktreeMergesOnBoot`.
  `pullRequestHosting.ts` answers WHICH checkout a card speaks for — its own
  while that directory exists, the worktree's main checkout once it does not —
  and the poller, the card's merge action and the repository identity above all
  ask it, so a card outlives the worktree it was published from.
  `pullRequestIdentity.ts` owns what counts as the SAME pull request —
  `<provider>#<owner>/<repo>#<number>`, read off any repository or pull-request
  URL — because two repositories both having #7 is ordinary and one project can
  publish to both. `pullRequestIdentity()` returns both halves: the join key,
  and the `owner/repo` the inventory puts ON THE WIRE, because the client has to
  address a pull request too: its route carries project, provider, repository
  and number, because any smaller address names more than one of them.
  `pullRequestInventory.ts` builds the Pull Requests view's inventory —
  `GET /api/pull-requests` via `pullRequestHttp.ts` — by folding the 60 s
  per-project open-PR list (yours plus review-requested) together with the 15 s
  per-worktree hosting projection (merged/closed pull requests whose local
  worktree still exists, the cleanup queue), then joining each one to its
  worktree, sessions and Tasks as IDs; `docs/pull-requests.md` holds the
  contract. `pullRequestIdentityThrough()` is the shared "does this resolved
  provider speak for the pull request this request names" check, so the
  inventory's actions cannot drift about which repository a number belongs to.
  `pullRequestViewMerge.ts` is that view's merge action —
  `POST /api/pull-requests/merge`, also served by `pullRequestHttp.ts`: it
  resolves the repository from the four-component identity (asserting the
  checkout it found really is `provider#owner/repo`), holds
  `withPullRequestMutation` across BOTH halves, merges through
  `mergePullRequestAndProjectLocked` and then retires the local worktree through
  `worktreeRemoval.ts`, reporting each phase separately so a cleanup that
  refused can never read as a merge that did not land. It owns no lifecycle of
  its own: the merge and the retirement are the shared seams, and the head
  branch, base branch and checkout are re-derived here rather than accepted from
  the client. A landed merge (and a retirement) then drops what the inventory
  caches about that pull request — `worktreeHosting.ts`'s
  `invalidateProjectPullRequests` and `pullRequestInventory.ts`'s
  `invalidatePullRequestInventoryReads` — because the view refetches immediately
  and both of those stand for 60 s; each carries a generation so a read that
  started before the invalidation cannot repopulate it, and the identity key
  comes from the provider that answered rather than from the request.
  `checkPullRequestFromView` (`POST /api/pull-requests/check`) is that same
  resolution with NO side effect: what the pull request IS, read under the same
  lock. Acquiring the lock proves an unanswered request finished, and because
  the check attempts nothing no merge guard can refuse it — a re-issued merge
  would be refused forever by a pull request that has since become a draft or
  conflicted, leaving its client permanently unable to learn what happened.
  `pullRequestViewCheckout.ts` is the view's REVIEW action —
  `POST /api/pull-requests/checkout`, the same identity and the same lock:
  resolve the project's MAIN checkout and assert it is `provider#owner/repo`,
  read the pull request, fetch its head into `refs/remotes/origin/<head>`
  (network-bound, outside the repo lock, and `--no-write-fetch-head` so it
  cannot hand a LOCKED operation its rebase target through `FETCH_HEAD`;
  `pullRequestHeadFetchArgs` exists so that argv is asserted rather than
  described) and require the oid to equal the provider's `headSha`, then either
  create a tracking worktree through `worktrees.ts`'s `track-remote` source AT
  that exact oid, or bring the one existing checkout to it through
  `worktreeSync.ts`'s `pull-rebase` — handing it everything this module verified
  outside the lock (both oids AND the upstream's remote/merge identity, since
  any two refs at one commit satisfy an oid), so it is re-checked under that
  operation's own lock before it mutates anything. Even "it already stands
  there" goes through that operation, with `head === upstream` so it fetches and
  moves nothing: answering `already-current` from the lock-free reads would let
  a repointed upstream — or a DETACHED checkout sitting on the right commit —
  pass as success. Its answer is `created` / `updated` / `already-current` /
  `refused`, with the recorded merge-back base and the checkout's own LIVE
  `taskIds` (filtered through `taskSummaryFor`, the projection a client's Tasks
  list is built from, so an archived link is neither attached nor left to
  suppress a weaker one) stated beside the pull request's base; every git
  refusal — dirty, diverged, not tracking this head, a local branch of that
  name, a head the remote does not carry, two checkouts on the branch, a
  precondition overtaken by a race — is DATA on the 200, because the action
  attempted nothing it could not report and none of those is something it may
  resolve by guessing. It caches nothing and invalidates nothing: the local join
  it changes is computed from `listWorktreeRows()` on every read, and the
  provider-side caches still describe the same pull request.
  `pullRequestMerge.ts` is the ONE post-merge projection every merge surface
  goes through (`mergePullRequestAndProject`, or
  `mergePullRequestAndProjectLocked` for a caller that already holds the lock
  because the merge is only half of what it is serializing): it merges once and
  then writes every place the pull request is shown — each matching live card,
  the linked Task's `done` suggestion (asked once per linked TASK, not per card,
  and reported back as `taskSuggestions` — only the Tasks whose standing
  suggestion this projection created, since repeating one writes nothing), and
  `worktreeHosting`'s TTL cache — because sharing only the provider call let
  each surface update its own store and drift (a merge in chat left the worktree
  page offering Merge; a merge there left the card open until the watcher's slow
  poll). Cards are matched by REPOSITORY IDENTITY (`repoLockKey`) plus provider
  and number, never by checkout path, since the two surfaces reach the same pull
  request from different paths. Everything after the provider ACCEPTS is
  best-effort — each card's patch as well as the base refresh and the Workflow
  records — because a throw there would report a merge that landed as a failed
  action, and stop a caller that continues into a local cleanup. `cardIds` is
  therefore the cards it WROTE, not the ones it matched, and
  `pullRequestActions.ts` uses that difference: a card its own merge missed gets
  the terminal state from the action's outcome patch instead of only a message,
  since clearing `busyAction` over an open card would offer Merge again for a
  pull request that is already in. That final write is itself non-fatal, for the
  same reason. It also owns the `merge-pr` HTTP entry point, so
  `worktreeHosting.ts` keeps only status and creation, and
  `withPullRequestMutation` — the per-pull-request lock (repo identity +
  provider + number) that BOTH surfaces' mutations pass through, because
  `busyAction` only ever locked one card while the worktree page has none and a
  second card can exist for the same PR. The loser is refused before any
  provider/git side effect rather than queued. Under that lock it re-reads the
  pull request and BINDS what is being merged — head branch, base branch and
  draft state, not just the accepted head, because a retarget keeps the head
  while moving the pull request onto another base (the default branch included,
  past the approval a managed caller classified it out of). A caller carrying an
  accepted head demands that answer; an ordinary card click tolerates a provider
  that cannot be asked but never an answer that contradicts it. Whatever head
  this run validated — the reviewed one, or simply the one a click just read —
  becomes the merge's own atomic precondition, so a push in the final window is
  refused by the provider instead of merged. The same call site is where the
  repository's supported merge methods are enforced for EVERY surface: a FORCED
  capability read (no cache, and no adopting a request that started earlier)
  precedes the identity re-read — a network round trip must not sit between that
  check and the provider call — and an unsupported or unknown method refuses
  before the provider is asked. A managed caller also passes the
  `managedDecision` it acted on (base-is-default, the default branch it judged
  against, and an approval's frozen method set), which the seam revalidates
  against the same fresh answer, so a moved default branch cannot turn a direct
  merge into an unapproved default-branch merge and an approval cannot execute
  after its base stopped being the default. The managed tool's own check is an
  earlier, more legible refusal, not the only one. `pullRequestActions.ts`
  (stage 3, Task 324) owns the ACTIONS on that card — merge (method AND
  remote-branch fate per merge, both arriving with the click as
  `PullRequestCardActionOptions`, through that shared projection),
  `update-with-main` (deterministic `worktreeSync` pull-rebase + rebase-main +
  lease-guarded force push, handing the work to the session's agent only on a
  `WorktreeSyncConflictError`), `cleanup` (pull-rebase main →
  `branchContainedInBase` → `removeWorktree({ deleteBranch: true })` → settle
  the sessions, never forced, only when merged and only when the shared
  `settleBlockedReason` predicate says every session it settles may leave the
  inbox at all — the card's own plus the other sessions still LIVE on the
  checkout (`liveSessionIdsForWorktree`; a finished review session is not one of
  them), asked AGAIN under a worktree HOLD taken for the removal itself —
  `session/sessionRunLease.ts`, the small mutual exclusion between "this session
  is about to run" and "this session's checkout is about to be removed", checked
  inside `runtimePrompt.ts` so no prompt path can bypass it, and covering EVERY
  session linked to the worktree since a fork or a review handoff shares that
  checkout: all held together, all gated, all settled through the shared
  `settleSessionsForRemovedWorktree` the worktree page's Remove uses too), and
  `mark-task-done` (the user's ANSWER to the `done` suggestion a merge leaves on
  the linked Task, so it writes directly — and is refused unless the card is
  `merged`, since only a merge leaves that suggestion). Its side-effecting seams
  are injected (`PullRequestActionOperations`, like `PrWorkflowOperations`), and
  every action serializes on the card's durable `busyAction` so a second click
  is refused rather than racing the first — which is also why
  `reconcilePullRequestCardActionsOnBoot` (called from `index.ts`) releases an
  action the previous process died inside, leaving an `actionError` that says it
  was interrupted. Both local actions refuse a card whose base is not the
  worktree's (`/pr --base`), rather than acting on one branch and reporting the
  other. `connection.ts` only decides where a returned conflict prompt goes —
  the CARD's session, resolved through `hub.acquireById`, not whichever session
  is being viewed — and reports the handoff's outcome back onto the card
  (`recordRebaseHandoff`), so an unavailable session or a rejected prompt leaves
  a durable `actionError` rather than a card claiming a handoff that never
  happened. Success is recorded when the prompt is APPENDED (`onUserEntry`), and
  every such write carries the card's `updatedAt` from when the handoff was
  issued so a late outcome cannot overwrite a newer action's.
- `session/sessionRunLease.ts` is the mutual exclusion between starting a RUN in
  a session and REMOVING a WORKTREE. The held resource is the worktree, and each
  prompt resolves its session's CURRENT worktree at admission — so a session
  forked or handed off onto a held checkout after the hold was taken is refused
  by it too, which a snapshot of "the sessions on this worktree" could not do.
  `runtimePrompt.ts` takes a per-session hold for the length of every prompt and
  refuses outright while a removal holds the session; a removal reserves the
  session and is refused while a prompt is in flight. Both operations are
  synchronous check-then-set, which is why this works where sampling `isRunning`
  before the removal could not — the sample cannot see a run that starts in the
  gap before the deletion. It is in-memory on purpose: it guards an operation
  that lasts seconds, and a dead process takes both sides of the race with it.
- `slashCommands.ts` owns the ONE slash-command registry (sent whole to the
  client on `ready`; the composer filters by applicability). A command with
  `execution: "client"` (e.g. `/review`, which navigates the browser to a
  prefilled new-session review draft) is handled entirely in the web app:
  `connection.ts`'s `onRunSlashCommand` rejects such a name outright, so a stale
  or foreign client gets an error rather than a half-run command.
- `hostSlashCommands.ts` owns the `SyntheticToolHost` seam plus every
  host-driven slash command
  (`runCommitForHost`/`runPushForHost`/`runPrForHost`/`runCompactForHost`/
  `runClearForHost`), so `connection.ts` dispatches them harness-independently.
  The git-writing commands (`/commit`, `/push`, `/pr`) refuse while
  `host.sessionMode` is Plan (Task 332), as a finished error tool turn — one
  guard for both harnesses, worded as "did not run / switch to Build" and never
  as Plan being read-only or enforced. `/pr` uses three sequential synthetic
  turns through the same seam; its pull-request phase finishes with
  `finishSyntheticTool` plain text, never a card, because the live card lives in
  `pullRequestCards.ts` instead. `recordWorktreeProvisionForHost` reuses the
  seam for a card whose work happened OUTSIDE the turn (the first send's
  worktree, created before the session existed): it is therefore always
  terminal, and swallows a refused synthetic turn because a missing genesis card
  must not take the user's turn down with it. `/compact` is host-driven so that
  the memory flush/reset sequencing and the `CompactionDisplay` card live in ONE
  place and only the compaction step itself is per-harness (`compactContext`):
  pi calls its `AgentSession.compact`, the Claude harness drives the CLI's own
  manual compaction. `compactContext` may report `skipped` — a legitimate
  refusal (the Claude CLI answers "Not enough messages to compact." on a short
  conversation) that renders as plain tool output and, since nothing was
  replaced, deliberately does NOT reset the memory snapshot. `/clear` rides the
  same seam with the same flush/reset ordering and its own `ContextClearDisplay`
  boundary card. A running turn owns the context a clear would pull away, and
  `beginSyntheticTool` is the one place that refuses it — before any turn
  exists. A running-state check inside the runner is the trap here: opening the
  synthetic turn is itself what marks the session running, so such a check
  refuses every time (the fake-host and real-host tests in
  `hostSlashCommands.clear.test.ts`, `claudeSdk/ClaudeSdkSession.clear.test.ts`
  and `piSdk/piContextClear.test.ts` hold that line). Its per-harness step is
  `clearContext`: pi resets the session file's leaf AND empties `state.messages`
  (the branch and the live array are two halves of one context), the Claude
  harness forgets the resume id — persisting the record immediately, so a
  restart cannot resume what was cleared — after the supervisor closes any
  retained host, which it refuses while background work still holds one. Our own
  log is untouched either way: the transcript keeps every message, and the card
  marks where the model's context now starts.
- `mcp/`, `tools/`, `session/`, `piSdk/`, `claudeSdk/`, `worktrees/`, `memory/`,
  `dayScan/`, `speech/`, `packageProxy/`, and `db/` have child contracts.
- `gitExec.ts` owns the shared git CLI executor and the per-repository mutation
  lock (`withRepoLock` keyed by `repoLockKey` = the shared git common-dir, so
  the main checkout and every linked worktree serialize on ONE key); domain
  modules spawn git only through it. Execution failures surface as non-zero
  results, `gitOptional` absorbs them, and `gitOptionalExit` absorbs only
  failures from a git process that actually ran. Every mutating git operation
  that touches the WORKING TREE, the INDEX or a BRANCH OR TAG REF (commit
  workflow staging/commits, worktree add/remove, merges) must run under
  `withRepoLock(await repoLockKey(cwd), …)` — never lock by raw checkout path.
  "Branch or tag" rather than "local ref" is deliberate: `refs/remotes/*` are
  local repository refs too, so the loose phrasing made the network-bound
  exception below read as a contradiction of this rule instead of the narrow
  carve-out it is. NOT re-entrant; never nest for the same repository.
  `gitBoundedStdout` is the streaming read for output too large to buffer (the
  skills diff): it retains at most `maxChars` while consuming the rest for an
  authoritative total, takes the same read fan-out slot as `gitReadOnly` so a
  whole-repository stream cannot spawn without bound, and honours an
  `AbortSignal` by killing the child, so an abandoned tool call stops paying for
  a patch nobody will read. Waiting for a slot is cancellable too
  (`acquireReadOnlySlot`): a caller that gave up leaves the queue at once rather
  than cancelling only once a stranger's long read has finished, and because it
  never held a slot the accounting is untouched — `releaseReadOnlySlot` skips
  waiters that are gone and hands the slot to the next one still interested.
  Every read-only run (`gitReadOnly*`, `gitBoundedStdout`) also sets
  `GIT_OPTIONAL_LOCKS=0`: `git status` otherwise refreshes and rewrites the
  index (`index.lock` → `index` in the checkout's git dir), which made a watcher
  scan of a linked worktree a WRITER racing `git worktree remove` ("failed to
  delete '.git/worktrees/<name>': Directory not empty"). The answers are the
  same; nothing is touched (`gitExec.test.ts`).
- NETWORK-BOUND git operations are the deliberate exception, and it is bounded
  rather than open: submodule setup during worktree creation, `pushWorkflow.ts`
  pushes, and `worktrees/worktreeFetch.ts`'s remote-ref fetch run LOCK-FREE. The
  shared reason is that the lock is a MUTEX, not a queue, so holding it across
  an operation that can take minutes stalls every commit, `worktree add` and
  merge behind it. Each has its OWN safety argument, and they are NOT the same
  one:
  - **Fetch and push** are the named REMOTE-TRACKING exception: they touch no
    working tree, no index and no branch or tag ref, and the only refs they
    write are `refs/remotes/*`. Those are not exclusively ours — `git push`
    updates them too — so safety rests on Git's own per-ref locking plus the
    caller's retry: a loser fails that ref and is retried by the next sweep or
    reported to the user.
  - **Submodule setup** DOES write local state:
    `git submodule update --init --recursive` populates the new checkout's
    submodule working trees and creates worktree-private Git state under
    `.git/worktrees/<name>/modules/`. Its safety is ISOLATION, not ref locking —
    `worktrees.ts` runs it against a worktree that has just been created and is
    not yet recorded, so no other app action can address or reach that checkout
    while it runs.
- Adding an exception therefore means naming its own isolation or locking
  argument, not appealing to this list. Do not extend it to anything that writes
  local state a concurrent caller could reach, and do not weaken the rule above
  in a child doc: a child cannot loosen a parent contract, so a new exception
  belongs HERE.
- `config.ts`'s `BACKGROUND_FETCH_ENABLED` (`ASSISTANT_BACKGROUND_FETCH=1`) is
  opt-in per INSTANCE, not a general setting: PR previews share production's
  `projectsRoot` and checkouts, so it is set in the production service's own
  environment rather than the shared base env previews inherit — the same
  scoping rule the dictation vars follow.
- `hostTools.ts` owns the host-tool contract. The service PATH is the host's
  profiles rather than a vendored closure, so `config/host-tools.json` declares
  the binaries and dotted version floors the server expects and
  `verifyRequiredHostTools()` throws in `index.ts` before the socket binds,
  naming every failure at once. Resolution is a PATH walk (so "absent" and "too
  old" stay distinguishable) then `spawnSync` — not `execFileSync`, because
  version flags land on stdout for some tools and stderr for others and several
  print a version then exit non-zero. Checked once per boot on purpose. Tools
  the package wrapper vendors (`git`, `ssh`) must never be listed, and neither
  must OPTIONAL capabilities: those are discovered by their own subsystem and
  reported as a status with a reason (`speech/sttConfig.ts` is the reference).
- `instanceEnv.ts` owns the variables that bind a process to THIS instance
  (`DATA_DIR`, `ASSISTANT_TOKEN`, host/port, origins, public base URL,
  background fetch) and deletes them from `process.env` inside the
  `server.listen` callback — after `config.ts`, `authToken.ts` and `index.ts`
  have read each into module constants, and before any agent can be spawned.
  Sessions inherit the server's environment wholesale (pi runs in-process; the
  Claude CLI and its Bash tool are children), so without this an agent working
  in its own worktree saw production's `DATA_DIR` — which is how a feature
  branch's migration was applied to the production database. Deliberately not
  the whole `ASSISTANT_*` space: `ASSISTANT_STT_*` names shared immutable store
  paths, and provider credentials are filtered per session by
  `claudeProfileEnvironment`. The explicit `DATA_DIR=… pnpm …` form still works
  and is gated instead by `db/migrationOwner.ts`.
- `sessions.ts` owns session-list projection and boot-time repair of missing pi
  metadata rows from canonical native transcripts. The projection is rebuilt up
  to ~4 times a second while agents stream, on the thread that serves every
  connection, so it resolves its relations in BATCHES:
  `projectStore.sessionProjectIndex()`, `worktreeIdBySession()` and
  `objectRefsBySession()` are one indexed scan each (`db/links.ts`
  `outgoingByType`) instead of three SQLite round trips per row,
  `archivedSessionCount()` is a SQL `COUNT`, and the task-progress index is
  checked against `taskIndexVersion()` — a bare number — rather than a snapshot
  that built the whole Task list just to be told the cache was still valid.
  Measured against production data (59 active rows): 18.8 ms → 4.25 ms per
  rebuild, and 1.02 ms → 0.06 ms for the archived count. It is also the Sessions
  inbox's whole data source (`app/web/docs/ui-shell.md` has no say here; the
  browser contract is `app/web/src/components/CLAUDE.md`), so a new per-row
  lookup belongs in the batched prologue, never the loop: the pending-approval
  set (`pendingApprovals.ts` `pendingApprovalSessionIds`, one read of the
  FILE-backed store) and the queued-peer-prompt recipient set
  (`db/peerPromptStore.ts` `pendingDeliveryRecipientIds`, one query) are
  resolved once per build, never per session — as is the `/pr` card each
  session's row states (`pullRequestCards.ts` `pullRequestSummariesBySession`,
  which is itself memoized, and dropped by its own `writeStore`, because that
  store carries drafted bodies and linked Tasks rather than a handful of ids)
  and the Task-pick-blocked set off that same index (`choosingTaskSessionIds`).
  `hub.ts`'s merge and `claudeSdk/claudeSdkStore.ts` pass those same approval
  and Task-pick sets into each `ClaudeSdkSession.listItem`, so the SDK overlay
  does not re-read them per row either. It also refuses to report a shelved
  session as unread — archiving/settling marks it read, and the projection
  guards rows shelved before that rule. Beyond the durable metadata it carries
  `createdAt`, the precise `attention` kind (question vs approval vs
  `task-choice`, alongside the coarse `awaitingInput`), `runStartedAt` (from
  `sessionActivity.ts`, so an elapsed label is honest rather than derived from
  `updatedAt`), the persisted `lastError`, `queuedWork`, `settledAt` and
  `outcomeAttention`. Those last two are one decision
  ([Task-674](pa://task/674)): the projection is the ONE place the settlement
  mark and the durable attention revision are combined, and it withholds
  `settledAt` (and therefore suppresses the shelved-row unread guard) while the
  session's latest outcome is unacknowledged, so no consumer has to know that
  settlement has two halves. Task-495 adds one more batched prologue read,
  `subagentStore.delegationSummaries()`: only active child rows contribute,
  split into starting/working/awaiting-parent counts on
  `SessionListItem.delegation`. It never folds delegated activity into the
  parent's own streaming fields, and the store's touched-parent notification
  refreshes the row after every run-state change. The list is a DEFAULT
  PROJECTION in the `SessionScope` sense ([Task-492](pa://task/492)): the store
  read carries `user` rows only, and both live sources — the pi store's
  `listInfo()` here and `hub.ts`'s in-process SDK overlay — are gated by
  `sessionStore.liveDefaultScopeGate(<their live ids>)`, since neither carries a
  scope of its own. A live row with no metadata row at all is still surfaced
  (first prompt in flight); that is safe because `claimScope` persists a
  non-default scope BEFORE the session can enter either registry, and a gate
  that cannot read the store hides the live rows rather than admitting them.
- `sessionActivity.ts` owns the Sessions-inbox lifecycle facts derived from the
  harness-neutral `sessionRuntime` event feed, installed ONCE at boot from
  `index.ts`: in-memory run start times (run state is never persisted), the
  persisted last-run failure (`runStatus: "error"` only — an aborted turn is a
  user decision, not a failure; cleared the moment a new run starts), and the
  durable ATTENTION revisions a session's outcomes raise
  ([Task-674](pa://task/674)). Attention is event-based: one user-facing
  PROVIDER RUN outcome raises one revision, `completed` or `failed`, and nothing
  else in this module raises any — not a run starting, not a durable entry, not
  reading or routing — which is what lets a settled session run its next turn
  without leaving the shelf. The signal is `subscribeSessionRunCompleted`,
  deliberately NOT the `runStateChanged: idle` transition: idle is a SUPERSET
  that a synthetic host command (`/commit`, a skipped `/pr` phase) also
  produces, and waking a settled session for one would be exactly the tool
  activity this feature promises to ignore. The runtime's normalized
  `stopReason` decides — `aborted` raises nothing, `error` is the failure,
  anything else a completion — which is why no verdict has to be carried across
  events. `runStatus` keeps only the failure MESSAGE, so one outcome never
  spends two revisions. Only a DIRECTLY OWNED session raises one at all — the
  shared `isDirectlyOwnedSession` predicate, so a coordinator-owned spawned
  child's completion stays with the run above it. `sessionOutcomePolicy.ts` then
  keeps a successful agent-driven parent wake quiet while another explicitly
  requested peer reply remains outstanding; it also advances the read cursor
  through only the activity that intermediate turn introduced, unless older
  unread activity still precedes it. A human turn, parent failure or final
  expected report still raises. The raise asks for its own session broadcast
  rather than depending on the run's: a revision is a change every subscribed
  tab has to converge on, and the two debounced calls coalesce. A run start also
  TOUCHES the session's `updated_at_ms`: submitting a prompt is an update even
  though nothing has been produced yet, so the inbox re-sorts on the submit
  rather than on the turn ending. Both harnesses get this for free; neither
  reports any of it itself. The inbox facts that are not runtime events live
  there too, so a single module decides what moves a session in and out of the
  inbox: `settleSessionsForRemovedWorktree` settles the sessions still live on a
  worktree that was just removed and refreshes every session linked to it, and
  BOTH removal surfaces (the `/pr` card's cleanup, the worktree page's Remove)
  call it rather than answering that question differently.
  `markInterruptedRunsOnBoot` is the third: it records which sessions hold a
  turn the PREVIOUS process died inside, which no session can report about
  itself. Both harnesses hand the durable log a turn's assistant entry and its
  tool results in ONE flush at `messageCompleted`, so a killed turn leaves no
  transcript at all and the session reads as idle and healthy; the `run.started`
  / `run.ended` / `run.aborted` bracket `liveSession.ts` writes around every
  turn is the only evidence. Boot is the one moment it can be read honestly —
  nothing is live yet, so an open bracket cannot be a turn that is merely still
  going — and each log is WALKED BACKWARDS a chunk at a time
  (`LogPersistence.lastRunMarker`) rather than rehydrated. Nothing bounds how
  much follows an opener — the prompt that drove the turn is appended after it
  and has no size limit — so a single fixed tail would silently miss exactly the
  sessions this exists to expose. A log with no marker inside the scan cap
  (every log written before markers existed) answers "not interrupted" rather
  than guessing. The sweep covers the inbox WORKING SET only, not archived and
  not settled: that is the set a badge can be acted on in, and it is what keeps
  the walk affordable. Nothing running is lost by that scope, because a run
  start reactivates a settled session. Forks never inherit a bracket either —
  `copyPrefixTo` skips run markers exactly as it skips `message.providerBound`,
  since a fork cuts at a conversation entry INSIDE the turn and a copied opener
  would read as a crash in a child that has run nothing. The verdict lands in
  `session_index.interrupted_run_at_ms`, projects as
  `SessionListItem.interruptedRun` (suppressed while the session streams) and is
  cleared by the same run-start path that clears the last-run failure —
  deliberately on the next run STARTING, not on one succeeding, because by then
  the user is looking at the session and a continuation that fails on its own
  terms has `lastError` to say so. It is NOT folded into `last_error_*`: a
  restart is not a failure, it is work waiting to be continued.
  `settleCompletedWorkflowRunSessions` is the other one: a COMPLETED Workflow
  Run settles sessions it never gave a checkout, while every code-delivery role,
  including the coordinator, leaves with the run's checkout. The cleanup
  surfaces therefore keep stating exactly what they settle. Each candidate
  answers the shared predicate and a busy one is SKIPPED rather than refusing
  anything, since nothing is being destroyed.
  `settleCompletedWorkflowRunSessionsOnBoot` catches up runs that completed
  before the rule existed (`index.ts`, after the workflow run reconciler),
  skipping any session touched since its run ended so a restart cannot take back
  a session the user picked up again. It also owns the shared
  `settleBlockedReason` projections both surfaces gate on —
  `sessionSettleBlockedReason` for one session, `worktreeSettleBlockedReason`
  for the live sessions of a whole checkout.
- `worktreeRemoval.ts` is the worktree page's Remove as one decision, so that
  surface follows the `/pr` cleanup's contract instead of its own: refuse while
  a live session on the worktree may not be settled (before any git side
  effect), hold the worktree against runs starting
  (`session/sessionRunLease.ts`), ask again under the hold, then remove and
  settle. `force` overrides losing git work, never the session gates. Git's own
  guards stay in `worktrees/worktrees.ts` and still throw, so only the session
  refusals come back as a message; the seams are injectable
  (`WorktreeRemovalOperations`) like the pull-request actions'. Its
  `retireWorktree` is the full sequence (refresh the exact base target → verify
  containment → hold → remove → settle), shared by the worktree inspector's
  Retire, the `/pr` card's cleanup and the Pull Requests view's Merge & clean up
  (`pullRequestViewMerge.ts`); every refusal carries the `refusalKind` that
  decides whether a surface may escalate it to `force`.
- Settlement is a first-class session state, NOT a relabelled archive: settled
  sessions stay in the ordinary list and stay readable, while archive remains
  the deep "remove from normal surfaces" state (`db/sessionStore.ts` keeps
  `settled_at_ms` and `archived_at_ms` independent). `connection.ts`'s
  `settleSession` command enforces the eligibility invariant with the SAME
  shared predicate the browser disables its action with (`@assistant/shared`
  `settleBlockedReason` over the projected row: running, question-blocked,
  approval-blocked, or queued work), and re-sends the authoritative row before
  erroring so an optimistic client cannot stay on a false settled state. It also
  carries the attention revision the CLICKED row showed (`throughRevision`,
  clamped to the stored revision) rather than acknowledging whatever is true
  when it lands: a completion or failure that arrived since the render is an
  event the user has not seen, so a stale settle records its acknowledgement and
  leaves the row visible. Only a server-side settlement — worktree removal, a
  completed Workflow Run, subagent lifecycle inheritance, and the peers a
  settled coordinator still owns — omits the revision and acknowledges the
  current one: `sessionActivity.settleSessionWithPeers` folds the same projected
  rows along the shared spawn forest (`spawnClusterMembers` minus the roles of
  every working-set run, read from `workflowRuns.ts`), refuses with the shared
  aggregate reason (`spawnClusterSettleBlockedReason`) before any write, and
  then writes coordinator and peers in ONE store transaction
  (`sessionStore.settleWithPeers`, all-or-nothing). A shelved coordinator-owned
  peer's later FAILURE unsettles it from `recordRunOutcome` — no revision, so
  nothing top-level — so the fold can bubble it again. Unsettling is never
  blocked and never cascades. The command has NO silent-success path, because
  the browser's optimistic row is rolled back only by an error: it projects the
  row with `includeArchived` (the default list omits archived rows, so an
  archived-but-running session would otherwise resolve to nothing and skip every
  blocker), refuses when no row can be projected, and treats a store write that
  changed nothing (tombstoned row, DB trouble) as a failure.
- `promptAssets.ts` owns prompt-layer resolution and the report over it. A
  persona system prompt is composed by `personaPromptText(agentType, opts?)`
  (exposed per persona by `agents.ts`) in order: the persona markdown, this
  session's conditional integration sections, the `project-registry.md` asset,
  KB guidance, Memory guidance. Which conditional layers appear — and whether
  the registry pointer and the memory WRITE rules appear at all — comes from the
  session's frozen `PromptConditions` (`promptConditions.ts`); an absent
  condition set includes everything. The two file-backed layers resolve fresh
  from `PROMPTS_DIR` (so a prompt edit reaches the next new session), which is
  the PACKAGED `config/prompts` beside the installed app — never derived from
  `ASSISTANT_CWD`, the session cwd or the selected project — unless
  `ASSISTANT_PROMPTS_DIR` overrides it with an absolute existing directory.
  There are no fallback constants: the private `readPromptAsset()` is the single
  usability judgement, raising `PromptAssetError` with a `problem` of `missing`,
  `unreadable (<code>)` or `empty` (whitespace-only content would be trimmed to
  an absent layer). `assertPromptAssets()` (called by `index.ts` before
  `server.listen`) refuses to start when the packaged directory has any such
  defect, warning instead when it is under an override. `promptAssetInventory()`
  reports every layer's source (`file` / `builtin-code`), path, contributed
  characters and hash plus the composed prompt's size and hash;
  `promptAssetProblems()` is the non-throwing check behind the diagnostic and
  the gate, running the same read per asset so it cannot report a healthy
  install that a session then fails on. The harness-level additions — the pi /
  `claude_code` base prompt and the permanent profile suffix — are applied by
  the option builders and are not layers here.
- `promptConditions.ts` owns session-START conditional assembly
  ([Task-287](pa://task/287)): the `PromptConditions` record (attachments,
  slack/google/tempo gates, the Project Registry pointer, memory write
  capability), `computePromptConditions()` over a session's evidence, and
  `sessionPromptConditions()`, which freezes that record insert-only in
  `session_prompt_conditions` and returns the frozen one on every later call.
  The creating paths supply the evidence — `connection.ts`'s two first-send
  handlers derive it from the same message that builds the Task/Project
  attachment, pi carries it into `piStore.create()` (pi mints the id inside
  creation, so it cannot be staged by id) and a fork inherits its parent's
  record. Everything downstream READS: `piSdk/options.ts`,
  `ClaudeSdkSession.promptConditions()`, `claudeSdk/toolServer.ts` and
  `eagerToolNamesFor(agentType, conditions)`, whose `eagerWhen` groups (today:
  `attachments`) are eager only for a session whose condition holds. Nothing
  here may become per-turn: pi rebuilds the system prompt on every active-tool
  change and Claude resends it on every resumed query.
- `promptInventory.ts` + `measurePrompts.ts` own the committed prompt/schema
  measurement behind `pnpm run measure:prompts` (Task-281): per persona and per
  harness, the character size and resolved source of every prompt layer (harness
  base, the `promptAssets.ts` layers, the pi tool list and guidelines, the
  profile suffix, project context, assembly overhead) and of the tool block
  (eager names/descriptions/schemas, the HARNESS's own builtin definitions, the
  deferred universe). `tools:eager:harness-builtin` prices the vendor tools a
  session really carries: counted for pi's coding builtins (`read`/`bash`/
  `edit`/`write` + `grep`/`find`/`ls`, ~4.4k chars — the block was invisible
  before [Task-316](pa://task/316), which would have priced enabling the search
  builtins at the ~126 chars of their prompt snippets), and reported
  zero-and-UNCOUNTED for Claude, whose native definitions ship inside the CLI
  and cannot be read in-process. It measures with every condition ON and reports
  `conditionSavings` — what each session-start condition costs the sessions that
  carry it, per persona and harness. The eager prompt-extras row was dropped
  with the fields themselves ([Task-282](pa://task/282)); the pi tool-list and
  guidelines rows survive and are now provably ZERO for our tools, which is the
  measurement of that deletion. Prompt rows are DERIVED from real assemblies by
  subtraction — pi's own `buildSystemPrompt` via `piSdk/piPromptMeasure.ts`,
  `claudeSdkSystemPrompt` for Claude — so `reconciled` fails loudly instead of a
  hand-summed table drifting. Rows that are reported but not counted carry the
  reason (vendor-owned preset, guidance the harness drops, deferred tools).
  `piPromptMeasure.ts` deliberately reaches past pi's `exports` map for
  `buildSystemPrompt` and throws if a pi upgrade moves it.
- `promptBudgets.ts` + `checkPromptBudgets.ts` own the enforced side of that
  measurement ([Task-288](pa://task/288)): `config/prompt-budgets.json` holds
  every number, this module holds only the rules, and `pnpm run check:prompts`
  plus `promptBudgets.test.ts` fail on a breach in CI and in `pnpm run test`. A
  limit is a selector over the inventory's counted layers (sections, optionally
  narrowed by layer-id patterns), which is why `prompt`/`eagerTools`/
  `firstRequest` reconcile with `promptChars`/`eagerToolChars`/
  `firstRequestChars` by construction instead of by a parallel count. The
  measurement is normalized so CI can assert it — this checkout's
  `config/prompts`, `cwdLabel` in place of the checkout path (the cwd reaches
  the prompt twice, pi's cwd line and the `<project_context>` path, at ~2
  characters per character of path; the tool block does not carry it),
  `PI_PACKAGE_LABEL` in place of pi's install directory (pi's default prompt
  names its README/docs/examples by absolute path three times, so an
  un-normalized run measures a CI container differently from a developer
  checkout and moves on a pi version bump), every condition ON — and the
  committed layer table in `src/__snapshots__/prompt-sizes.md` is the review
  artifact for a size delta. Attribution comes from that snapshot as COMMITTED
  at the merge base (`committedBaseline`, read-only `git show`), not from the
  working tree, whose copy is regenerated by the same change that grew it and
  could therefore explain nothing; a layer absent from the baseline counts as
  growth from zero, and with no baseline reachable the message lists the largest
  layers instead of claiming an attribution. A limit whose selector matches no
  counted layer is an error rather than a permanently green zero. Raising a
  budget is expected rather than exceptional: the append-ordered `raises` log
  records why, and a last entry that no longer matches its budget fails the
  check. Policy in `docs/prompt-budgets.md`.
- `taskOverhead.ts` + `measureTaskOverhead.ts` own the Task-bookkeeping
  measurement behind `pnpm run measure:tasks` (Task-299), the instrument for the
  audit in `docs/tasks.md`. It reconstructs each session's provider calls from
  pi's `native.jsonl` and, for Claude, the CLI transcript joined through
  `session_index.provider_session_id` — falling back to `claude-sdk/<id>.json`,
  which collapses a turn and therefore yields calls but never round trips, a
  distinction every aggregate keeps by naming its cohort. It charges a round
  trip only to a turn whose tool calls were ALL `task_*`, reports the
  continuation's input both processed and cache-uncovered, classifies each call
  into lifecycle steps per OPERATION so batching shows as fewer calls for the
  same steps, and reuses `promptInventory`'s accounting for the eager `task_*`
  block. The data dir's `app.sqlite3` is opened READ-ONLY for the session index,
  the `session → context → task` links and the storage counters; nothing in this
  path writes.
- `sessionAudit.ts` + `sessionAuditSources.ts` + `measureSession.ts` own the
  per-session, per-turn usage and context-contributor report behind
  `pnpm run measure:session` and the `session_audit` tool (Task-254) — the
  RUNTIME counterpart to `promptInventory.ts`'s static measurement, and the
  before/after instrument for the rest of the token sub-epic. `sessionAudit.ts`
  is pure over an injected `SessionAuditSource` (metadata plus two file paths),
  which is what lets the committed fixture under `test/fixtures/sessionAudit/`
  pin the whole report in a regression test with no database. The persona tool
  inventory it measures against is injected the same way
  (`SessionAuditOptions.inventory`): `tools/catalog.ts` composes the
  `session_audit` tool itself, so it hands its own `catalogAuditInventory` down
  rather than being read back up. Omitting it is legal and lands in
  `unavailable`, never silently empty. It reads the app log for turn structure,
  content sizes, tool calls/results, failures and compaction cards, and the
  per-request transcript (pi `native.jsonl`, or the Claude CLI transcript) for
  provider calls, reasoning tokens and context jumps; a session with neither
  reports those fields as `unavailable` rather than estimating them. Processed
  input and context occupancy stay separate fields under the post-turn stats
  row's names (Task-251), occupancy carries the `reported` vs `prompt-token-sum`
  basis so the store's own fallback is never passed off as a harness snapshot,
  log totals are reconciled against `session_usage_totals` over a NAMED field
  set (`persisted.comparedFields`), and a >5% gap between the log and the
  transcript is reported as a warning instead of being reconciled away. The
  stored `usageTurns`/`assistantTurns` are deliberately outside that set: pi
  increments them per app-log assistant entry but `claudeSdkStore` derives them
  from the SDK RECORD's entries, so they count different populations (27 Claude
  sessions in the live data dir differ there while every token figure matches).
  They are still returned under `persisted.totals`, beside the report's own
  `totals.usageBearingRuns`. Cost is the one field the two harnesses persist
  under DIFFERENT accumulations, and the difference is deterministic rather than
  float noise: pi's `recordUsageTurn` → `addUsageTotals` rounds each entry's
  `costUSD` to micros and sums the integers (`Σ round(c)`), while
  `claudeSdkStore` hands `replaceUsage` the SDK record's already-accumulated
  float, rounded ONCE (`round(Σ c)`). Either one alone is wrong for half the
  sessions — surveyed over the live data dir, where the regimes disagree the
  stored value matched its harness's regime 31/31 for Claude and 13/13 for pi,
  and the other 0/0. The report therefore computes both (`totals.costMicros`,
  `totals.costMicrosSingleRounding`), reconciles against EITHER, and names the
  one that matched in `persisted.costAccumulation` — exact, and without encoding
  a per-harness store detail in the comparison. There is no tolerance anywhere:
  a cost matching neither regime is a real difference and is reported with both
  candidate values. Character-derived figures are named `estTokens`
  (`chars / CHARS_PER_TOKEN`) and the static rows (system prompt, tool
  definitions) are measured against THIS checkout, which every row states in its
  `basis`. Attachment rows are BYTES (the log stores a reference, not the body):
  only text-like MIME types convert to `estTokens`, and `binary-attachments` is
  reported unconverted and out of every share, because a screenshot's bytes say
  nothing about its image tokens. Calls to names this checkout's catalog does
  not have are `callsNotInThisCatalog` — harness builtins AND app tools since
  renamed or removed, which a transcript cannot tell apart and which an
  instrument for measuring tool removals must not label as builtins.
  `sessionAuditSources.ts` resolves a session id twice: in-process through
  `sessionStore` + `resolveInspectableSession` (so the audit inherits the
  deleted/internal refusal), and for the CLI against any data dir with a
  READ-ONLY `app.sqlite3` handle — never `getDb()`, which would migrate the
  user's live database from a checkout.
- `knowledgeBasePrompt.ts` owns the harness-independent KB agent-prompt
  guidance: the minimal eager pointer `knowledgeBaseBehaviorGuidance()`
  (triggers KB search, forbids direct writes) injected as a `promptAssets.ts`
  layer. Full operational guidance (when/how to read/write, scoping, linking,
  validation, provenance, secrets) lives in the `kb_*` tool descriptions so it
  activates when a deferred knowledge group loads ([Task-284](pa://task/284)).
  Since [Task-286](pa://task/286) deferred `knowledge-core` as well, the pointer
  is also the only eager surface that makes the KB discoverable, and says so:
  the `kb_*` tools load on demand via tool search.
- `memoryPrompt.ts` owns the harness-independent memory agent-prompt guidance:
  `memoryBehaviorGuidance(agentType, canWriteMemory?)`, injected as a
  `promptAssets.ts` layer alongside the Project Registry and KB sections. It
  teaches loaded-snapshot precedence, `[id@revision]` references, when to
  search/store/correct, and persona differences (coding personas are read-only +
  write only on explicit user authorization; `personal-assistant` adds the
  temporal rule). Per-argument rules stay in the memory tools'
  `description`/schema prose.
- `knowledgeBaseContract.ts` owns the executable constants, schema interfaces,
  and path helpers for the first-class KB v1 contract documented in
  `docs/knowledge-base.md`, plus `knowledgeEntryFrontmatterHelp()` — the
  canonical, always-valid frontmatter skeleton (enums/schema literal derived
  from the constants so agent guidance cannot drift from validation) surfaced in
  the KB write/edit tool schemas and guidance.
- `frontmatter.ts` owns dependency-free splitting of byte-zero YAML frontmatter
  fences and the limited YAML subset shared by server-owned storage domains:
  maps, sequences, scalar values, and inline scalar arrays. It deliberately does
  not implement general YAML or know any domain schema.
- `skills/skillLibrary.ts` owns the browser-facing read of the library: it
  bootstraps the store, scans the working tree, and builds the `skills` topic's
  one `skillList` message (`libraryPath` + summaries + diagnostics), answering a
  read that could not run at all with `error` rather than an empty library.
  `publishSkillLibrary` pushes that message through the topic seam, which is
  what a `skills` subscribe calls in `connection.ts`: the subscribe IS the
  authoritative rescan, and its result reaches every subscriber rather than the
  asking connection alone, so two open windows cannot disagree. Nothing here
  caches — a cached index would let Settings show a skill that no longer matches
  the file a session injects.
- `skills/skillDetail.ts` owns the bounded read of ONE skill
  ([Task-614](pa://task/614)). `readSkillDetail(name)` accepts a DECLARED name
  only — `isSafeSkillName` first, then a fresh scan, then the file that scan
  reported — so a caller can neither supply a path nor address a folder the
  scanner rejected. It answers `null` for a name the library does not declare at
  all (the caller's 404) and the shared invalid state for one it declares and
  cannot serve: the folder's own diagnostic, or the deletion/replacement/broken
  frontmatter that happened between the scan and the read. That race never
  becomes a filesystem error and never falls through to another folder — an
  `ENOENT` would leak an absolute path, and a fallback would serve one skill's
  instructions under another's name. `resolveSkillDetail` is the same resolution
  against a caller-held scan, which is the only way to exercise that race. It
  opens the source through `skillSource.ts` and compares the scan's recorded
  folder and file identity before serving anything, so a folder or file replaced
  since the scan answers invalid instead of being read. The body is the Markdown
  below the frontmatter, read through one handle so the reported `bytes`
  describe the file that was read, bounded by `MAX_SKILL_BODY_BYTES` and decoded
  in streaming mode so a character cut by the bound is dropped rather than
  mangled.
- `skills/skillFiles.ts` builds one deterministic recursive supporting-file tree
  beneath the open skill folder and owns skill-relative path reads
  ([Task-615](pa://task/615)). `SKILL.md` sorts first and each remaining sibling
  sorts byte-lexically; shared entry/depth/path-metadata limits bound the answer
  and travel with it. The READ is bounded too: each directory is iterated lazily
  and only as many names as the walk could still answer with are ever held (a
  bounded insertion keeps the same deterministic first N a full sort would
  give), and the depth check asks whether a directory has ANY child instead of
  listing it. Reads validate every relative component and open it beneath the
  held folder descriptor through `skillSource.ts`, never following a
  supporting-file symlink. It classifies MIME from a fixed map, detects NULs in
  text previews, bounds previews and raw files separately, and converts
  deletion/replacement races to path-free domain errors. `readSkillTextWindow`
  is the agent-facing read behind `skill_read_file`: it reuses the same resolve
  and no-follow open, refuses a non-text file as `SkillFileNotTextError` rather
  than decoding it, and answers one line window bounded by BOTH a line cap and a
  byte budget — a lone line longer than the budget is clipped at a character
  boundary and reported as truncated, since refusing it would make the file
  unreadable. The refusal is the DECODE, not just the MIME map and the NUL scan
  the preview uses: a `.md` file holding one stray Latin-1 byte carries no NUL,
  and answering with a replacement character where content is would hand an
  exact-match editor text the file does not contain. `fatal` draws that line,
  and the FLUSH decides where an incomplete FINAL character falls: identical
  bytes mean either content this read chopped at 256 KiB or a file that really
  ends mid-character, so streaming is passed only when the bound cut the file
  and a fully read one is flushed and refused. `ignoreBOM` keeps a leading
  U+FEFF, since a window that disagrees with the bytes on disk is not verbatim.
  The prefix's last line is dropped when the file runs past the 256 KiB read
  bound, because half a line is not a line an edit can be copied out of.
- `skills/skillsHttp.ts` owns `/api/skills/*`, dispatched from `index.ts` and
  therefore behind the same token/origin gate as the rest of the API surface.
  `GET /api/skills/detail?name=<declared-name>` serves bounded instructions plus
  the recursive tree. `GET /api/skills/file?name=…&path=…` serves bounded raw
  bytes; `preview=text` returns the shared bounded preview union. Missing/unsafe
  names and paths are 400, unknown/deleted files are 404, and oversized raw
  files are 413. Raw responses carry fixed MIME, no-sniff, sandbox CSP,
  no-store, and safe disposition headers. The library LIST deliberately stays on
  the `skills` topic.
- `skills/skillLibraryEvents.ts` is the domain's ONE broadcaster seam, installed
  by `hub.ts` as `broadcastTopic("skills", …)`. The default no-op keeps unit
  tests and one-shot callers hubless; the domain never broadcasts app-wide.
- `skills/skillSource.ts` owns the ONE way library bytes are reached and now
  written, shared by the scan, the single-skill read, and the authoring tools.
  It opens the library root, then each component below it relative to that
  descriptor through `/proc/self/fd` with `O_NOFOLLOW`, and hands back the live
  `SKILL.md` handle plus the `dev`/`ino` identity taken from the SAME `fstat`.
  That is the point: a pathname resolved twice is two questions, and a
  `SKILL.md` swapped for a symlink between the check and the read used to
  publish an outside file's frontmatter as a valid skill (reproduced under a
  worker-thread rename stress). Nothing is read through a pathname, so identity
  is worth comparing against later and a swap is refused, not followed. Opens
  omit `O_DIRECTORY` deliberately — Linux answers `O_DIRECTORY|O_NOFOLLOW` on a
  symlink with `ENOTDIR`, which would erase the symlink diagnostic — and add
  `O_NONBLOCK`, so a FIFO left where `SKILL.md` belongs cannot hang a scan
  waiting for a writer; the kind of each entry is then checked on the open
  handle. `/proc/self/fd` makes this Linux-only by construction, with no
  pathname fallback. The authoring helpers write through the same anchor:
  `O_NOFOLLOW|O_CREAT|O_TRUNC` file writes, `withSkillChildForUpdate` for the
  read-then-rewrite of one open `SKILL.md` inode, directory creation that
  refuses an existing link and reports whether it created, and top-level folder
  reservation (`withReservedSkillFolder`, whose `mkdir` cannot overwrite, which
  refuses a reservation that is not EMPTY when it is opened — no syscall creates
  a directory AND returns its descriptor, so a directory adopted in that gap
  must at least be one that can lose nothing — and which HOLDS it open so its
  inode cannot be reused underneath a later check), the create-or-fail placement
  set (`createSkillChildDirectory`, `createSkillChildFile`, `linkSkillChild`,
  each failing `EEXIST` as `SkillNameTakenError`, with `link` keeping a symlink
  a symlink), and `skillChildStillIs` for re-checking that a name still resolves
  to a pinned inode. REMOVAL never acts on a public name: A removal that fails
  once entries are already gone reports `partial` rather than "not ours", so the
  caller can have Git restore what it took instead of refusing over a tree it
  has broken. `removeVerifiedSkillTree` renames a whole tree to a private
  `.pa-skill-removing-<uuid>` and only then identifies it, optionally checks its
  contents, and empties it, so every unlink and `rmdir` below resolves a name
  nothing else can rebind; `unlinkSkillChildIfSame` does the same move-aside for
  one file, brackets that check with the inode's `ctime` and puts the `unlink`
  immediately after the second reading. `clearSkillDirectory` does the same for
  a whole tree, which needs it more: proving and emptying are separate walks and
  the proof of an early file can be arbitrarily old by the time its unlink comes
  round, so `SkillTreeContents.provedAt` carries each entry's `ctime` from the
  check into the walk — files AND directories — and the walk rereads each one
  before it acts: a directory before listing it, a file before unlinking it. An
  entry whose reading moved, or that has NO reading recorded, stops the removal,
  which is then the `partial` outcome its caller already knows how to restore.
  The second case is the one a per-file check cannot see by itself: creating an
  entry moves its directory's `ctime`, and a hand author holding that directory
  open from before the detach can still create in it, so "nothing recorded" must
  mean refuse rather than "nothing to check". `treeHoldsCommitted` builds the
  same expectation for a DELETE out of the repository's committed objects, since
  a delete has no placement to compare against and removing a skill is not
  licence to remove a file somebody added to its folder; it reads them with ONE
  `committedFiles` call rather than a Git process per file, iterates lazily, and
  spends a shared entry/depth budget capped at `MAX_PLACED_ENTRIES` and
  `MAX_REMOVED_DEPTH`, refusing a bigger folder before anything is detached.
  `restoreDetachedDirectory` is bounded and proved the same way: each pass
  relinks what it finds and `clearLinkedAside` empties the aside of exactly
  those inodes, so an entry created behind the relink walk — which a descriptor
  held from before the detach still permits — is left rather than unlinked, and
  `MAX_RESTORE_PASSES` stops a racer from making the restore run forever. The
  residual is the same everywhere: one write landing between that reading and
  the `unlink` next to it (the residual is a write inside that one syscall gap,
  which POSIX cannot exclude), and takes an optional `holdsExpected` check that
  runs on the entry UNDER ITS PRIVATE NAME — where what the check reads and what
  gets unlinked cannot come apart — so a file is removed only while it still
  hashes to what the mutation put there. Metadata cannot stand in for that: an
  inode survives a rewrite through it, a size can be matched, and a modification
  time can be put back with `utimes`. Which check that is comes from the
  placement's `PlacedContent`, a closed set rather than an optional field:
  `bytes` for content the mutation wrote, `committed` for content it moved,
  `symlink` for a target that cannot change without its inode, and `unproven` —
  which removes NOTHING and satisfies no expectation, because "no expectation
  was recorded" and "no expectation is needed" must never be the same value. The
  same union gates the rename's SOURCE deletion: `treeHoldsExactly` compares
  every file's content, not just its inode, so an in-place edit of the source
  manifest — the one file a rename reads and does not carry across — refuses the
  removal instead of being deleted under a commit describing the version the
  tool read. Conflating them is what let a freshly written manifest be taken
  back on the strength of its inode alone. A rejected tree is put back by
  REASSEMBLY — `mkdir` claims the public name or fails, and the files are
  hard-linked across — because a `rename` back would replace a directory raced
  into that name; a file is put back with `link` for the same reason. When the
  name is taken, nothing is forced: the tree stays under the aside and is named
  in the error. Every identity comparison is against an inode the caller PINS,
  since an inode number is reused the instant its entry is deleted — so each
  create-or-fail primitive takes the creation BACK when it cannot pin it (a
  second open can fail on its own, `EMFILE` most plausibly, and a created name
  nothing can prove ownership of is one no undo may remove), and otherwise hands
  back a `SkillPin` (`createSkillChildDirectory` from the re-opened name it
  requires to be EMPTY, `createSkillChildFile` from the descriptor it wrote
  through, `linkSkillChild` from a pin verified against the still-present source
  link, `ensureSkillChildDirectory` only when `mkdir` itself created the
  directory), and `pinSkillHandle` re-pins an inode a caller already holds
  without resolving any name. A pin is opened `O_PATH`: a descriptor that refers
  to an inode without opening it for I/O, which is what lets a SYMLINK be pinned
  at all — an ordinary open answers `ELOOP` — and it is taken through
  `/proc/self/fd`, so no pathname is walked twice. `writeSkillChildFile` tries
  `O_CREAT|O_EXCL` FIRST and returns a pin only when it CREATED the file, so a
  caller learns from the kernel rather than from a probe whether Git or the
  mutation owns that path's undo. `withReservedSkillFolder` takes its own
  `mkdir` back when anything between it and the callback fails: until the caller
  HAS the reservation, no path and no undo are registered anywhere, and an empty
  directory is invisible to `git status`. `iterateSkillDirectory` is the lazy
  read for a caller with a bound of its own: `readdir` materializes every name
  before the first can be looked at, `opendir` does not. Nothing here creates a
  symlink or writes through one.
- `skills/skillLibraryScanner.ts` owns a fresh, deterministic read of the skills
  library working tree. It scans only non-hidden top-level entries that stand
  where a folder would — a directory, or a symlink RESOLVING to one, which is
  listed with its refusal so a linked-in skill does not silently vanish; a link
  to a file or to nothing is ignored exactly as the top-level file itself would
  be. It scans folders in batches of `SCAN_CONCURRENCY`, since every folder scan
  holds two descriptors while it runs, and reads each `SKILL.md` bounded at
  `MAX_SCANNED_MANIFEST_BYTES` — generous, because the served-body bound
  deliberately does not apply to frontmatter, but finite, because this read
  happens for every folder on every list and every mutation. It reads every
  candidate through `skillSource.ts`, validates `SKILL.md` through the shared
  `skillManifest.ts` rule and only decorates its issues with the folder they
  belong to, keeps source folder/path identity separate from the declared name,
  and returns the shared wire model's valid summaries plus explicit
  malformed/duplicate diagnostics. It never consults or caches by Git HEAD;
  duplicate declared names make every affected folder non-injectable. What a
  declared name may be is the shared `isSafeSkillName`, not a scanner-local
  regex, because `settings.ts` keys the toggle map on that same name.
- `skills/skillResolver.ts` is the pure name resolver. It intersects valid scan
  summaries with an ordered list of toggle layers, applies later-layer
  overrides, and returns sorted unique names; Phase 1 passes only the global
  layer, while the explicit list is the extension seam for narrower scopes.
- `sessionSkills.ts` is the one coding-session lifecycle seam. It reads an
  existing insert-only freeze first, otherwise resolves and freezes on coding
  creation/start, and accepts a parent preset for forks. The ordinary creation,
  peer-spawn, workflow, pi lifecycle, Claude fork, and common runtime-prompt
  paths all use it; the common boundary covers reopen and legacy first start.
  Non-coding personas never scan or persist. `activeSkillsForSession` is the
  read-only SessionState projection and never creates a freeze.
- `skills/skillInvocations.ts` derives `SessionState.skillInvocations` from a
  transcript's tool calls: a `Skill` call qualified with the session's own
  runtime plugin name (`skillRuntimePluginName`), or a `Read`/`read` of the
  materialized `SKILL.md`, counted only once a non-error result is in. Both
  harnesses call `skillInvocationTrail` at projection time; nothing is stored.
- `settings.ts` owns `AppSettings.skills`, the sparse global on/off map
  ([Task-613](pa://task/613)). Normalization drops an entry whose key is not a
  safe skill name or whose value is not exactly `"on"`/`"off"` and coerces
  NOTHING — a stray truthy value read as `"on"` would enable a skill nobody
  enabled — but KEEPS an entry the current library does not declare, since a
  hand-authored library loses a name during an edit, rename, branch switch or
  failed scan and dropping it would discard the user's decision. Normalization
  therefore never consults the scanner. Like the peer-runtime roster, the
  section is replaced WHOLE and its normalizer answers a non-map with an empty
  map, so both guards exist: `validateClientMessage.ts` rejects a `skills`
  section that is not a map of the two states, and `updateSettings` applies one
  only when it really is a map. Without them a malformed patch would silently
  turn off every skill the user enabled. An EMPTY map stays legitimate — that is
  how the last entry goes. New coding sessions consume the global map through
  `sessionSkills.ts`, and both harnesses inject the resulting frozen names;
  narrower project/session scopes ([Task-532](pa://task/532)) are a later phase.
- `skills/skillLibraryStore.ts` owns lazy, idempotent bootstrap of the
  user-owned `DATA_DIR/skills` repository AND the one committing mutation seam
  ([Task-633](pa://task/633)). Bootstrap creates the directory and runs only
  `git init -b main` when `.git` is absent — still no author config, staging,
  commit, `.gitignore`, or change to an existing repository — while a stable
  bootstrap chain closes the one-time pre-/post-init lock-key boundary and
  `git init` itself runs under `gitExec`'s canonical repository mutation lock.
  `status()` reports cleanliness including untracked files, the branch and HEAD.
  `commitMutation` takes the canonical repository lock once, refuses a dirty
  repository with the changes named, refuses a present `.git/index.lock` BEFORE
  writing (it coexists with a clean status and fails staging and restoring
  alike, which is the one combination that could strand a write), runs the
  caller's resolve/apply/validate work, stages only the paths that work
  registered, commits with per-invocation identity and
  `commit.gpgsign=false`/`gc.autoDetach=false`, and runs its optional
  `afterCommit` hook (the skills publish) while STILL holding the lock so no
  broadcast can describe the next mutation's writes and a failed publish cannot
  unmake the commit. Rollback restores every touched path one path at a time — a
  per-path restore because one never-committed pathspec would otherwise abort
  the whole `checkout` and skip the restores that mattered — and then VERIFIES
  it by re-reading status: a tree that is not clean again produces an error
  naming both the original failure and what is left behind, instead of the
  original error over a working tree that still holds the write. A mutation
  CLAIMS what it made — `created`, `wrote(path, bytes)`, `removed`, `damaged` —
  and only claimed paths are staged, because `add -A` on a broad name stages
  whatever occupies it and a hand author is not serialized by the lock. Each
  claim also carries the PROOF of what it put there — the exact bytes, or the
  path it MOVED content from — and `assertStagedExactly` then reads the index
  back and makes every entry answer for itself: a deletion must fall below a
  removed path, and an addition or modification must be a claimed path whose
  proof holds, meaning the index entry is the mode the repository already had
  (or the 0644 every write here makes) with the object id those bytes hash to,
  in the repository's own hash algorithm — or, for content the mutation MOVED,
  is exactly what the repository has committed at the path it came from, mode
  and object alike. Mode is part of the proof because it is part of the entry: a
  concurrent `chmod +x` is a change this mutation did not make. Neither a
  pathname nor an inode is a proof: the name can be the claimed one while the
  bytes are a hand author's, and a hard link keeps its inode number through a
  truncate-and-rewrite, so identity answers "is this still the same file?" and
  never "is this still the same content?". Committing either would publish their
  work as the tool's. Anything unproven refuses the commit. Restoring is the
  stronger claim still: `git checkout HEAD --` reverts whatever differs from the
  commit no matter who wrote it, so it runs only while the path still holds the
  exact bytes `wrote` recorded, or nothing where `removed` said the mutation
  emptied it; `damaged` (a truncation, or a tree removal that failed halfway) is
  the one unconditional restore, because there the committed copy is the only
  intact one. Rollback also survives its own Git step failing: the mutation's
  undos, the pin release and the status proof all still run, and a restore that
  could not run is named in the error. Every mutation reports at the moment of
  the change rather than before attempting one — a write at the truncating open
  (`writeSkillChildFile`'s `onTruncated`), a removal only once it succeeded, and
  rename/delete once `removeVerifiedSkillTree` reports `removed`. Reporting
  earlier would let a refused operation revert a hand edit; reporting never
  would let a refused COMMIT leave the mutation applied. The generic
  `git clean -fdq` runs for exactly one case, a path that did NOT exist when it
  was registered and that this mutation then WROTE; a name it merely registered
  holds somebody else's content by the time rollback sees it. Anything else a
  mutation created is taken back by the mutation itself: `onRollback` registers
  an undo for a failure that lands after `run` returns (a refused `git add`, a
  rejecting `pre-commit` hook), and the store runs those undos, last registered
  first, AFTER the generic restore has emptied what it can revert. That generic
  restore goes no further than Git can prove: `reset` for the index and
  `checkout HEAD --` for content it has committed, and NO `git clean` — a path
  Git cannot restore is one the mutation created, and that name may hold
  somebody else's file by rollback time. `committedFiles` yields whole ENTRIES
  (mode and object), because an object id alone cannot tell a regular file from
  an executable one or from a symlink whose object is its target, and
  `modeStillCommitted` answers the mode half in Git's terms: owner-execute only,
  and only where `core.fileMode` is on, so a repository that does not track
  modes is not refused over a `chmod` Git itself ignores. `blobId` over a
  descriptor brackets its read — same size and `ctime` before and after, nothing
  beyond the hashed length — and answers with an empty string when any of that
  moved, so a prefix a concurrent writer left matching can never pass for a
  match; the detached private name stops new OPENS, not writes through a
  descriptor taken before it. `hold` is what makes the undos truthful: a
  mutation pins every inode it creates and hands the descriptor to the store,
  which closes them once the attempt has settled and before it re-reads status.
  Without that lifetime an undo compares a NUMBER the kernel has already handed
  to whatever a hand author put at the same name, and deletes their file
  believing it is its own. Each is conditional — a file only while it is still
  the inode this call linked, a directory only while it is empty — so a file a
  hand author added under an assembled name survives, keeps its parents alive,
  and is reported by the post-rollback status check rather than cleaned away.
  `history` returns subject and trailers only with the subject truncated by Git
  and the stream capped, keeps a cut trailing record whose identity fields are
  complete (dropping it reported a single commit with a 300 KB trailer block as
  no history), reports `truncated` when older commits went unread, and treats
  ONLY an unborn repository as empty history — decided through `gitOptionalExit`
  AND the exit code, so a git that could not RUN throws and so does one that ran
  and FAILED: with `--quiet`, `rev-parse` exits 1 for "HEAD names a branch with
  no commit" and 128 for a fatal error such as a corrupt `.git/HEAD`, and only
  the first is an empty past. `%B` used to stream whole messages, so one huge
  hand-authored message could overflow the executor and be reported as no
  history at all. `history`/`diff` validate revisions against option-shaped
  input, pass `--end-of-options`, and carry the caller's `AbortSignal`.
  `commitMutation` takes one too, and exposes it to the mutation as
  `ctx.checkpoint()` plus a one-way `ctx.beyondCancellation()`: the checkpoint
  throws `SkillMutationCancelledError` while stopping is still free and does
  nothing after, and the store latches it off itself at the first
  `damaged`/`removed` claim, once `run` returns, and before any rollback — so
  the undos, which hash content through the same `blobId`, can never be cut
  short by the signal that caused them. The context's `blobId` consults the
  checkpoint between chunks, which is what makes hashing a multi-gigabyte
  hand-authored file interruptible without making any write interruptible. Its
  exported `skillLibraryStore` is the process-wide instance every path uses —
  the `skills` topic, the HTTP detail read, and the agent tools — so they share
  one bootstrap and one lock chain. `config.ts` separately exposes
  `SKILLS_RUNTIME_DIR` for generated `DATA_DIR/skills-runtime` output; bootstrap
  never creates it.
- `skills/skillManifest.ts` is the ONE frontmatter rule, shared by the scanner
  and by authoring. `parseSkillManifest` returns either a valid manifest or the
  scanner's own diagnostic codes (plus a recovered name, which duplicate
  detection still needs); `assertSkillManifest` is the throwing form a mutation
  validates with, so there is no second "tool-valid" schema. It also formats the
  source a tool writes: the declared name as a plain scalar and the description
  as a JSON-quoted one, which the shared YAML subset reads back byte-for-byte,
  and `withDeclaredName` rewrites only the root `name:` line for a rename rather
  than reformatting a hand-authored file.
- `skills/skillAuthoring.ts` is the layer between the agent tools and the store.
  It resolves a DECLARED name to the scanned folder and opens it by INODE
  (`withVerifiedSkillFolder` compares the scan's `dev`/`ino`), because the
  repository lock serializes the app against itself and not against the user
  hand-authoring the same tree, applies create/edit/file- batch/rename/delete
  through the anchored no-follow seam, re-scans, and refuses a result that is
  not valid or that adds any diagnostic the pre-write scan did not have. It owns
  the strict skill-relative path validator (no absolute, traversal, backslash,
  NUL, or `SKILL.md`), the operation/byte bounds, the exact-replacement editor,
  and the bounded `skill_get`/`skill_list` reads. A batch's `edit` operation
  runs that same editor over a supporting file: it reads and rewrites through
  ONE open description (`withSkillChildForUpdate`), so the text a replacement
  matched and the bytes it overwrites belong to the same inode; it refuses a
  file that is not valid UTF-8 instead of writing back what a lossy decode
  invented, decoding with `ignoreBOM` because the edited string is re-encoded
  whole and a swallowed byte-order mark would be a change outside every
  requested region; and it creates nothing, so the generic HEAD restore owns
  undoing it, exactly as it does for a `SKILL.md` edit. Its result bytes cannot
  be known before the file is read, so the planner charges it no byte budget and
  relies on the per-file read bound instead. One successful commit publishes the
  library exactly once, through the store's `afterCommit` hook so the publish
  scans under the same lock that made it. A rename never calls `rename`: POSIX
  `rename` REPLACES an empty destination directory and this runtime cannot reach
  `renameat2(RENAME_NOREPLACE)`, so the new name is ASSEMBLED out of
  create-or-fail calls instead — `mkdir` per directory, `link` per file or
  symlink, `O_CREAT|O_EXCL` for the rewritten manifest — and the old folder is
  removed as a WHOLE through `removeVerifiedSkillTree`, which refuses it if it
  gained content. Hard links make that placement free and its ownership
  provable, which is what lets `placeSkillChildren` and the tree check act on
  inodes rather than on names, and a rename reports the source as modified
  (`ctx.willModify`) only once its tree really went, so a refusal cannot make
  the rollback revert a hand edit to a path it never wrote. Moving the children
  with `rename` was tried and reverted: it silently replaces a same-named file.
  A create writes through the held descriptor and then proves the name still
  resolves to it, DISOWNING the path (`ctx.disown`) when it does not, so neither
  staging nor rollback touches a folder that turned out to be the user's. A
  delete moves the verified folder to a private `.pa-skill-deleting-<uuid>` name
  and empties it there, so no unlink resolves a name another actor addresses.
  Destinations are registered with the rollback only AFTER they exist, and each
  mutation undoes itself without overwriting, against PINNED identities only. A
  DESTRUCTIVE step is pinned too: `pinSkillSource` opens the scanned folder,
  pins it and its manifest, and re-reads that manifest through the pinned handle
  to confirm it still declares the skill named, so a delete and a rename's
  source cleanup are bound to held descriptors instead of to scan numbers that a
  removed-and-recreated folder answers to just as well. A rename places at most
  `MAX_PLACED_ENTRIES` (512) entries, since each costs a held descriptor, and
  refuses a larger folder rather than placing what it could not take back; the
  source is walked through `iterateSkillDirectory`, so that ceiling bounds the
  READ too and a folder big enough to be a problem is never listed into memory
  before the refusal. `removeAssembledSkill` detaches the assembled folder to a
  private name and, inside that detached tree, takes back entry by entry exactly
  what the call placed — each file by the inode it linked, each directory once
  emptied. Only a folder that ends up empty is removed; one still holding a hand
  author's file is reassembled at its public name with just that file in it. A
  delete proves each entry as the KIND of thing the repository committed
  (`holdsCommittedEntry`): a committed symlink must still be one and must still
  point where its committed blob says, read back through the anchored, `ctime`-
  bracketed `readSkillChildLink` since a symlink can only be replaced, never
  written through; a committed file must not have become a symlink or a
  directory, and its mode is compared inside the same bracket as its content, so
  a `chmod` landing between the two cannot be recorded as the proved reading.
  Every mutation takes an optional `signal` and checkpoints it between the
  pre-write scan's batches, before its first write, and inside its proof walks,
  per entry as well as per hash chunk. A removal's expectation runs while the
  tree is DETACHED, so a cancellation taken there is turned into "this tree does
  not hold what you expected" (`cancellableExpectation`), which is the answer
  that reassembles the folder at its public name, and re-thrown only afterwards;
  `notCancelled` keeps the walks' own `catch`es from reporting a stop as a
  content conflict. A rename's inline undo declares `beyondCancellation()`
  before it takes anything back.
- `skills/skillRuntimeMaterializer.ts` maps a sorted, unique scanner-validated
  frozen name set to `DATA_DIR/skills-runtime/<sha256>`. It builds a valid
  Claude local-plugin manifest and one whole-source-folder symlink per skill
  under the pi-compatible `skills/` root. A generated completion record plus
  exact manifest/link validation permits deterministic reuse; unique staging and
  atomic rename publication recover safely from repeated, concurrent, or
  interrupted calls. Runtime directories remain disposable caches of the library
  working tree, not source of truth.
- `knowledgeBaseEntry.ts` owns KB entry parsing and v1 schema validation,
  deterministic Markdown/YAML/JSON/JSONL formatting, and the tool-facing
  `commitValidatedKnowledgeChanges` wrapper that validates/formats text writes
  before the storage layer touches disk. Its `beforeApply` hook also enforces
  the day-scan artifact guard (`dayScan/pathGuard.ts`): ordinary agent/user
  commits cannot write day-scan-owned assets or alter a day/meeting entry's
  generated region — only the `day-scan`/`day-synthesis` actors may (the honest
  day-chat contract).
- `knowledgeBaseStore.ts` owns the Git-backed KB storage core
  (`KnowledgeBaseStore`) over `DATA_DIR/knowledge`: repo init, path-validated
  atomic `commitChanges` with structured `KB-*` commit trailers (including
  optional `KB-Comment` for comment-thread workflow commits), tree/history/diff
  reads (including `commitChangedFiles` = a commit's changed source files with
  normalized statuses), bounded source/generated file reads,
  `restorePaths`/`revertCommit`, and gitignored `.kb/generated` artifact
  helpers. All caller-supplied Git revisions
  (`diff`/`showCommit`/`readFileAtCommit`/`restorePaths`/`revertCommit`) are
  validated (no leading `-`) and passed after `--end-of-options`, so
  option-shaped revisions like `--output=<file>` cannot turn a read into a
  write. Mutations serialize on the KB repo via `gitExec` `withRepoLock`;
  repo-local `gc.autoDetach=false` keeps automatic Git maintenance inside that
  lock, and `commitChanges` may run a domain validation hook there before
  writes. It stays free of UI, agent tools, and frontmatter-schema concerns;
  callers that accept user/agent entry text must layer `knowledgeBaseEntry.ts`
  validation/formatting above it.
- `knowledgeBaseIndex.ts` owns the rebuildable KB tree index and search (KB 05)
  over `knowledgeBaseStore` nodes + validated frontmatter: a hierarchical
  browsable tree (folders, entries, invalid entries, assets, files; empty
  leftover folders pruned; `index.md` folded into its entry), ranked search
  across title/aliases/tags/headings/body/asset metadata with
  compact/standard/full detail levels, and a deterministic write-if-changed
  generated artifact at `.kb/generated/index/kb-index.json` (`getKnowledgeIndex`
  reuses it until KB HEAD moves). Pure/read-only over the store; it never writes
  source of truth.
- `knowledgeBaseHttp.ts` owns the browser-facing read-only KB HTTP surface under
  `/api/knowledge/*`: the compact app-shell tree payload, one readable entry
  document by id/path (`/entry`, resolving body Markdown, metadata, assets, and
  `pa://` references via `objectLinkResolver`, and degrading to an invalid-entry
  state), compact inspector payloads (`/inspect`, metadata/related
  objects/history/bounded diff without body Markdown; the diff carries the raw
  patch plus structured per-file old/new text for rich rendering), raw
  entry-local asset bytes (`/asset`) for inline images/downloads, and raw bytes
  of ANY KB source file (`/file?path=<repo-relative>`, entry asset or loose file
  addressed by its full tree path — no entry identity; `readEntryBytesBounded` +
  `resolveSourcePath` enforce containment and reject reserved/generated/control
  paths) for the main-pane file viewer. Entry history is DOCUMENT history:
  `entryHistory` keeps only commits that changed the entry folder (following
  moves via the entry-id trailer) and drops comment-log-only commits
  (`isCommentLogOnlyCommit` — the retired comment workflow's commits touched
  only `.kb/comments/…`) so they never render as empty diffs, and the default
  diff is the latest content commit. `resolveKnowledgeEntryResponse` and
  `resolveKnowledgeInspectorResponse` are the testable entry-building seams.
- `knowledgeBaseAssets.ts` owns KB asset APIs (KB 06): entry-local `assets/...`
  path containment, compact asset listing that merges frontmatter metadata with
  actual asset files, bounded binary/text reads, source asset commits that
  update `kb.assets`, and generated text extract helpers under
  `.kb/generated/extracts/`.
- `comments/resolveAnchor.ts` owns the ONE anchor resolver behind
  `docs/comments.md`, shared by every commentable surface: the ladder (stored
  position → block hint → exact quote disambiguated by ±32 characters of context
  → bounded `approx-string-match` fuzzy → orphaned), the derived 1-based line
  range, and the two deliberate refusals — an exact quote whose duplicates
  context cannot separate orphans instead of falling into fuzzy matching, and a
  quote under 12 normalized characters never reaches the fuzzy step at all. All
  offsets in and out are into the RAW document text. Worktree review comments
  are its reader.
- `knowledgeBaseContext.ts` owns structured Knowledge-entry/comment session
  context renderings: compact metadata and `pa://knowledge/<id>` refs only,
  never raw entry bodies; comment starts add bounded thread/snippet context. It
  renders as either runtime attachments or text-only prompt preambles.
- `tools/knowledgeBaseTools.ts` owns first-class KB v1 agent tools (`kb_tree`,
  `kb_search`, `kb_get_entry`, `kb_write_entry`, `kb_edit_entry`,
  `kb_add_asset`, `kb_move_entry`, `kb_history`, `kb_diff`, `kb_read_asset`
  (bounded UTF-8 read of one committed entry-local asset, e.g. a day-scan
  snapshot/rollup JSON; refuses binary), plus asset/extract helpers). Tool
  outputs are compact JSON by default, and mutations must route through KB
  validation/storage helpers with Git commit metadata. `kb_add_asset` accepts
  exactly one source — inline `contentBase64`/`contentText` or
  `sourceAttachmentId` (a `sessionAttachments` id copied server-side so raw
  uploaded/Slack bytes bypass the model context).
- `contacts.ts` owns the contacts domain layer over `db/contactStore.ts`: the
  general people directory (NOT time-logging specific; time-logging routing is
  one consumer). Id derivation, field normalization/bounds, identity-based
  dedup/merge (`upsertContact` merges by email/jiraId/slackId — scalars
  overwrite, arrays/id-maps union), `setContactFields` (REPLACE roles/areas for
  corrections), `lookupContacts` (identity/area/free-text), and the compact
  `projectContact` projection. Self-enriching per the time-logging-routing plan;
  agents record newly discovered people/ids in any context.
- `objectLinkResolver.ts` owns compact server-side title/route/existence
  resolution for shared `pa://` object links; it must not load full object
  bodies.
- `taskComments.ts` owns the Task activity trace (Task 116): flat, append-only,
  chronological comments over `db/taskCommentStore.ts`, projected to the wire
  `TaskComment` shape. `addTaskComment` (user via `connection.ts`, agent via a
  `task_manage` operation's `comment`) appends, broadcasts the authoritative
  `taskComments` list through the `taskEvents.ts` seam, and calls `tasks.ts`
  `notifyTaskChange()` so `TaskSummary.commentCount` badges refresh; there is no
  threading, resolve/reopen, editing, or text anchoring. `taskEvents.ts` is the
  broadcaster seam (mirrors `knowledgeBaseEvents.ts`), installed by the hub.
  `connection.ts` watches only the currently open Task trace: a correlated
  `listTaskComments` answer starts it and `unwatchTaskComments` stops it; later
  broadcasts carry no originating browser request id. `tasks.ts` `listTasks`
  fills `commentCount` from `taskCommentStore.countsByTask()`, and `deleteTask`
  hard-removes the trace.
- `taskContext.ts` builds the hidden `task-context` prompt attachment for a
  Task-attached session (harness-neutral; both `connection.ts` first-send paths
  and the ordinary `prompt` path use it). It takes the post-nudge `TaskItem`
  `linkTaskStart` returns, reads the parent/grandparent and the trace itself,
  and renders the header, the Task description, the clipped parent description,
  the most recent comment and the folded project context
  (`sessionProjectContext.ts` `buildProjectContext`) inside one ~8 KB budget
  spent in priority order, replacing any dropped block with a line naming what
  is missing. The attachment id encodes the Task id (`taskctx-<id>`) so the web
  chip can link back. `taskNaming.ts` chooses the first linked Jira key as the
  Task's naming reference and falls back to its internal id. `taskContext.ts`
  writes that primary key into the header, and `sessionNaming.ts` parses it with
  `- Title:`/`- Status:`/`## Description`. The no-tool model returns only the
  descriptive title; server code adds the exact reference to generated and
  fallback titles. The product rule it implements is in `docs/tasks.md`.
- `sessionProjectContext.ts` resolves a session's Project (standalone link
  first, then the originating Task) and renders that Project's registry evidence
  as the `project-context` attachment or the folded block inside a task-context
  one. `buildProjectContext` renders the guidance against the evidence the
  record actually has — Jira precedence only with Jira links, the alias rule
  only with aliases — while the hint-not-instruction rule, the override rule,
  the deferred `project_registry_*` tool names and the one-line Project
  knowledge pointer are unconditional; `docs/reference/prompts.md` owns the
  rationale and the measured sizes.
- `textBudget.ts` owns the app's single truncation vocabulary for model-facing
  text — the marker and the clip shared by `taskContext.ts` and the bounded
  `task_read` payload in `tools/tasks/taskTools.ts`. Clipping counts UTF-16 code
  units (never splitting a surrogate pair) and appends the marker, so a clipped
  value is slightly longer than its limit and a byte-budget caller charges
  itself for the result.
- `memoryEvents.ts` owns the memory broadcaster seam (mirrors
  `knowledgeBaseEvents.ts`): the hub installs the connected-client
  `broadcastAll` during construction, and this module subscribes to the memory
  domain change + effective-load events, emitting compact targeted
  `memoryInvalidated`/`memoryLoadInvalidated` messages so open panels refetch
  authoritative data without bloating session-list payloads.
- `projectRegistry.ts` owns the Project notify-with-touched-ids seam, persisted
  revisions, lean summary projection reads, digest and targeted-item recovery.
  `hub.ts` coalesces those notifications into archived-inclusive `stateEvents`;
  browser and agent mutations never push a complete `projectList`, so every open
  sidebar converges without a reload.
- `subagentRegistry.ts` narrows durable thread and held-thread run projections
  into bounded summaries, revision sidecars and keyed detail reads. `hub.ts`
  coalesces the store's post-commit touched-id seam into registry events and
  per-held-thread run events; `connection.ts` owns parent-authorized detail
  topics, snapshots, digests and item fetches.
- `backgroundWorkRegistry.ts` is the single narrowing boundary between
  `db/backgroundWorkStore.ts` rows and the `background` topic: PA identity,
  bounded state, frozen deadline, the host epoch's state, the bounded command
  and description, and evidence FACTS (`providerBound`, sizes, truncation,
  refusal reason) — never a vendor task id, process id, path or artifact body.
  `hub.ts` coalesces the store's post-commit touched-id seam into `stateEvents`
  — reading revisions for the reported ids only, never the whole table, so a
  flush costs the change and not the history — and, because the owner's activity
  moved, one session-list rebuild; `connection.ts` answers a subscribe with the
  `backgroundWorkList` snapshot plus its revision sidecar. That snapshot is
  `backgroundWorkSnapshot()`: a BOUNDED window — active work first, then the
  newest history, capped at `BACKGROUND_WORK_SNAPSHOT_MAX`, read by
  `listRegistryWindow` as active rows through their partial index plus just
  enough newest history, with each revision taken from its own row — because
  terminal rows are retained until their owner session is deleted, so an
  unbounded answer grows with the install's age ([Task-656](pa://task/656)). The
  sidecar covers exactly the rows that shipped, a row outside the window arrives
  as an ordinary upsert the moment it changes, and `truncated` tells the surface
  its list is a window. There is still no way to ASK for the next one:
  per-session and deep-linked history older than the window is absent until a
  scoped or cursored read exists. `backgroundWorkBoot.ts` holds this process's
  random boot epoch (exposed as `backgroundWorkBootEpoch()`, which every
  admission stamps onto its row) and runs the boot reconciliation that marks a
  previous process's nonterminal work lost. The provider-neutral service ABOVE
  those rows — Settings, eligibility and admission — is `backgroundWork/`
  (`reference/server-background-work.md`); `settings.ts` carries its
  `AppSettings.backgroundWork` card and normalizes it on both the read and the
  write path.
- `workflowRuns.ts` owns the Workflow Run projection and broadcaster seam
  ([Task-364](pa://task/364), `docs/agent-workflows.md`): the single row→wire
  mapping over `db/workflowStore.ts` (`workflowRunSummaryOf`, `workflowStepOf`,
  `workflowEventOf`, and the composed `workflowRunDetail` per-run read), plus
  the `workflow` topic's `workflowRunList` snapshot — which `connection.ts`
  answers a subscribe with — and `broadcastWorkflowRuns()` for the runtime to
  push after a change. The list includes `workflow/cardProjection.ts`'s pure,
  recipe-owned card projection only for non-terminal runs whose exact recipe id
  and version it understands (terminal and unsupported summaries need no step
  read), so phase, activity, role sessions, review evidence and the next action
  arrive without polling or a per-run fetch. Review evidence includes the
  reviewer's own summary, findings and observations, and one session per review
  pass; because this is a LIST broadcast the projection bounds those lists and
  flags a shortened assessment rather than dropping the remainder silently. It
  also carries the newest review set that published FINDINGS, counting its
  anchored findings against what the fix round RECORDED (resolved, disputed,
  unanswered) rather than reading the review store — the worktree's own review
  surface is where live thread state belongs. Newest-with-findings, because an
  accepting review and a passing verdict each publish an empty set: keying on
  the newest set would blank the answered findings exactly when the run
  finishes, while a verdict demanding more changes still takes the card over. A
  paused run whose tail failed or blocked also carries that step's own result
  summary as `blockedReason` ([Task-398](pa://task/398)): the recipe's pause
  reason only names the step and its status, so without it the explanation an
  executor wrote reaches nothing but sqlite. Beside it, `repeatedAttempts`
  counts the identical consecutive attempts at that tail
  ([Task-399](pa://task/399)) — the recipe's `identicalTailAttempts` over the
  `predecessorId` chain, present only from the second one on, so a retry that
  reproduced its predecessor's outcome is legible and the chain reads as one
  number rather than N identical steps. The hub installs the broadcaster during
  construction, so the runtime and its tools stay independent of it and a caller
  with no live hub broadcasts into a no-op.
- `workflow/` owns the Workflow Run RUNTIME ([Task-365](pa://task/365),
  `docs/agent-workflows.md`): the recipe decision function, the engine that
  turns its decisions into persisted state, registered result contracts, the
  executor registry, and the session-backed agent executor. `runCleanup.ts` is
  the separate irreversible follow-up for cancelled runs: optional forced
  worktree/branch removal and session archival happen before the cancelled row
  and its cascading history are deleted, so a resource refusal preserves the
  retry surface. The runtime writes no SQL: every mutation goes through
  `db/workflowStore.ts`; browser updates go through `workflowRuns.ts`. Only
  `agentExecutor.ts` crosses into session acquisition and prompting; the recipe
  and engine remain independent of harness and Git details, while focused
  host-operation modules own Git effects.
  - `codeDeliveryRecipe.ts` is the one v1 recipe, ordinary TypeScript rather
    than a declarative graph: `decideNextStep(run, steps)` returns `append`,
    `executing`, `pause`, or `complete`. It is PURE — run row plus steps in
    append order, no clock, no I/O, no randomness — which is what makes crash
    recovery safe, since the same history re-derives the same step instead of a
    twin. It owns the step payload shapes (`role`/`objective` for agent steps,
    `operation`/`idempotencyKey` for host operations, the idempotency key
    derived from persisted step ids) and the phase walk plan → implement →
    initial commit/sync → exact-SHA CI observation → review. Finding lineages
    loop through commit-only → CI → author re-check; a cleared lineage inserts
    base-sync before the next discovery pass. Delivery inserts the same base
    freshness checkpoint before verdict/publication, looping up to
    `run.maxIterations` (counted from history; there is no loop counter). One
    `assessment` primitive serves three mandates: a discovery review (fresh
    eyes, one session per pass), a RE-CHECK by the agent whose findings a fix
    answered (`assessmentAuthorOf` reads the newest outstanding `revise` from
    history, so a CI round or a semantic retry in between cannot lose it), and
    the optional verdict. A cleared re-check settles the findings, not the head:
    the fix moved what would ship, so the run synchronizes once and buys another
    discovery pass. `hasPassingDiscoveryReview` matches the assessment's exact
    assigned base/head range, not head alone, and is what delivery refuses
    without, which is why no re-check or verdict can substitute for fresh eyes.
    Red CI bypasses reviewer admission and carries machine-attributed check
    findings to whichever fixer is already working (`activeFixerAssignment`),
    since a failed check names no author and offers nothing to route;
    `none`/`timeout` continue as explicit evidence. An exact-head discovery
    `pass` reaches the coordinator's `review-decision` step — unless nothing is
    open there (at the pass ceiling with no verdict to name), in which case the
    recipe delivers and a one-pass run pays nothing for the question.
    `acceptedReviewDecision` keeps a decision only while every runtime it names
    belongs to its role set; an unusable answer is not stretched into an
    authority — after a pass it delivers, after a revise it falls back to the
    implementer session, after a cleared re-check it takes the pass on the run's
    own reviewer. A ceiling that blocks a step the recipe NEEDS does not pause:
    it appends a `raise-ceilings` user decision (`ceilingDecisionStep`) carrying
    which ceiling blocked, what the run wanted, what it has spent, and the
    choices it can actually carry out — `deliver` only with a commit behind it,
    which a dirty worktree does not have. Answering `raise` re-derives the
    blocked move from the history BEFORE the gate, so nothing remembers what the
    run was about to do; a raise that still leaves it blocked opens the gate
    again rather than stranding the run. `fail`, a non-completed step, and a
    completion missing its contract payload all pause with a reason naming the
    step. The payloads also carry the reviewer↔implementer exchange, since the
    roles never message each other: a rework payload carries the findings, the
    reviewer's summary and its observations, and a review payload carries
    `implementerReport` — the implementer's summary, notes and answers to
    earlier findings (`implementerReportOf`). Both also carry the `focus` a
    review decision set for them: where a pass looks first, or how a fix round
    approaches findings whose scope is settled, which is the only thing the
    coordinator can say to the agent that does the work. `decisionFocusOf` reads
    it from the RAW decision rather than through `acceptedReviewDecision`, so an
    out-of-set runtime loses the session it named without taking the diagnosis
    down with it, and `isAllOrNothingGroup` drops the whole key under payload
    pressure rather than clipping an instruction into its own opposite. Review
    decisions also carry the accepted implementer's identity/family, every prior
    DISCOVERY reviewer's identity/family (`isDiscoveryReviewStep` keeps
    re-checks out of that diversity evidence), and every prior fix round with
    the lineage it answered and the size the following commit/sync MEASURED
    rather than the fixer's own account of it — a fix that outgrows the
    implementation is the shape of re-implementation, and no agent's report of
    its own work is evidence. A routing question adds `findingRounds`
    (`findingFixRounds`): per THREAD, how many fix rounds already answered that
    finding and had it raised again, counted from the fix assignments a thread
    appears in, since a re-check restates a finding verbatim and the server
    adopts its existing thread. `fixStep` records `fixerLineage` on every round
    so those rounds can be read per conversation — inert for session identity,
    which keys the fixer role by the payload's `fixer` — and `findingRounds` is
    all-or-nothing like `focus`, because a partial lookup table relabels a
    finding several rounds deep as one nobody has tried. The key travels on
    every routing question even when the table is EMPTY, and
    `shrinkPayloadGroup` never drops an empty all-or-nothing group: absence has
    to mean "did not fit", which is what `unavailableRoundsLines` states under
    the findings so an unmarked finding is never read as new.
    `rebaseRepairSpent` walks the attempt chain to decide whether a conflict
    episode still has its one automatic repair, and counts only repairs that
    reached an agent: a step carrying the host's `assignmentUndelivered` mark
    (`undeliveredAssignment`) is walked past like the commit-sync attempts
    around it, so a prompt refused before its turn never costs the episode its
    repair.
  - `resultContracts.ts` registers the typed contracts (`work-plan` — which
    deliberately carries neither a review-pass count nor a fixer/verdict choice,
    since nothing has been written when it is submitted — `review-decision`,
    widened to the coordinator's three questions (`deliver` naming a verdict,
    `review-again` naming a reviewer and focus, `fix` naming who answers the
    findings — and, with the same optional focus, how — refused at submission
    when it names nobody), `implementation-result` with its optional
    `responses`, `assessment` with its mandatory `headCommit` and its
    `findings`/`observations` split, `commit-sync-result` with its bounded
    per-range change evidence and previous/current base/head movement metadata,
    `ci-observation-result` with exact-SHA per-check machine evidence) with
    plain predicate validators, plus `readStepResult(step, contractId)` — the
    one reader that turns "ended in another status / another contract / an
    invalid payload" into the single condition the recipe pauses on. The
    validators live here so the submitting tool and the reading recipe share one
    definition, which is also why the cross-field rules — a `pass` carries no
    findings, a `revise` carries at least one — live here and are refused at
    submission time, while the step still runs. A finding's optional anchor is
    validated as a pair (`path` and `line` travel together or not at all);
    `commentId`, `reviewSetId` and an implementation result's `resolutions` are
    server-written, so they are accepted but never demanded of an agent.
  - `reviewSets.ts` ([Task-520](pa://task/520)) is the review loop's side of
    durable worktree review sets. `session_submit_result` calls it before the
    step becomes terminal — a result is written once, so the published ids must
    be part of it: an `assessment` becomes ONE closed, non-blind set on the run
    worktree (a thread per anchored finding, verdict mapped `pass`/`revise`/
    `fail` → approve/request-changes/reject, the submitted summary), and an
    `implementation-result` gains the per-finding `resolved`/`disputed`/`open`
    state read back from those threads. A reply from the set's own author is not
    an answer to its finding. The set's id is DERIVED from its step
    (`workflowReviewSetId`), not fresh, because a submission can be attempted
    more than once: a repeated attempt finds its own set, adopts the threads
    already in it, opens only the missing ones, and closes it — and a failure
    after creation closes the set on the way out, so an interrupted publication
    never leaves a review showing as in progress. Adoption matches a finding's
    whole identity (severity, original anchor, text) and keeps every candidate,
    because a review may make the same point at two places: keying on text alone
    let one of them claim the pair's only remembered thread and the other open a
    third, so the retry diverged instead of converging. A finding matching
    nothing opens a new thread rather than reusing one that is not it. A
    RE-CHECK is the one assessment that publishes into another step's set — the
    one it wrote — and SETTLES it: a finding it did not restate is accepted, so
    that thread is answered and resolved; a restated one is answered and
    reopened whatever the fix round marked it. It recognizes its own findings
    through the thread ids its assignment carries, never through anchors, since
    the fix it just read is what moved those lines, and it allocates every exact
    (severity, path, text) match across the whole submission before any
    wording-only fallback, so a same-worded NEW finding cannot take the thread a
    later restatement names. Both durable effects converge independently: the
    reply is skipped only when this exact line from this session is already the
    thread's newest word, and the disposition is re-applied from whatever the
    thread is in now, so a crash between them repairs on the next attempt. The
    settlement text comes from the resolutions the ASSIGNMENT carries rather
    than the live thread state, which is what makes a retry write the same
    words. Server-owned evidence (`reviewSetId`, a finding's `commentId`, an
    implementation result's `resolutions`) is STRIPPED from the submitted
    payload before any of this: the contract validator sees payloads the server
    has not yet enriched, so this is the only place that trust boundary can be
    drawn, and an invented `commentId` would otherwise delete its finding from
    the fix assignment (the handoff section renders threads, the inline list
    renders the rest). Publication is best-effort and never costs a run its
    result; the assessment remains the run's evidence either way.
  - `executors.ts` is the registration seam: ONE agent executor (it owns
    `startStep`, since only it knows the session, and the eventual
    `completeStep`) and host operations by id, each declaring a recovery policy
    (`retry-safe`, `observe-first`, `indeterminate`) that boot reconciliation
    obeys. Every executor context includes the persisted predecessor chain when
    the step has one, so an operation can validate a semantic retry without
    reading the store. `resultContractIdOf` defensively reads the contract id
    from an agent payload for the generic submission path. A step kind or
    operation with nothing registered pauses the run.
  - `agentExecutor.ts` ([Task-367](pa://task/367)) executes every code-delivery
    role in the run worktree, including the coordinator's two assignments in ONE
    constrained `workflow-coordinator` session. Its decisions cost no session at
    all. It reuses the latest still-resolvable role session — keyed by review
    PASS for a reviewer, so a re-check returns to the eyes that wrote the
    findings, and by lineage AND runtime for a fixer (`fixerSessionKey`), so a
    repeat continues in the session that remembers its failed attempt while an
    escalation opens a fresh one. Nothing enforces a session ceiling, because
    what a run may open follows from its two ceilings. It replays the run's
    resolved model/account configuration, links first assignments to the Task,
    reserves the step before prompting through `promptRuntimeSession`, and
    leaves completion to `session_submit_result`. Assignment prompts are pure
    renderings of recipe payload evidence — the review rubric that keeps
    findings actionable, the reviewer's words on a rework assignment, and the
    implementer's report and answers on a review assignment — with ONE exception
    it does not own: the review-set handoff section, which dispatch reads
    through `worktrees/reviewHandoff.ts` (I/O, and re-anchored after the fix
    range's commit) and passes in. A fix assignment carrying that section lists
    only the findings that have no thread and does not repeat the claims
    convention; a verdict assignment renders each prior finding with the
    resolution its thread recorded. Prompt send rejection fails the
    still-running step and re-advances without waiting inside dispatch. An
    assignment for a role session that is still mid-turn — the ordinary case,
    since an agent submits its result from inside a turn — is not sent and not
    failed: the reservation stays `pending`, an `observation-recorded` event
    names the session, and a background wait re-enters `advanceRun` once the
    runtime reports the session idle (polled through `sessionRuntime.isRunning`,
    500ms, 15 minutes). That wait abandons itself, leaving the reservation for a
    resume or the next boot, as soon as the step or run moves under it or a
    graceful drain starts; on timeout it pauses the run naming the session. A
    prompt rejection it can prove preceded the turn — `SessionBusyError`,
    `InactiveSessionError`, the worktree-missing refusal — also records
    `assignmentUndelivered` on the failed step; anything unrecognized is treated
    as a turn that ran, so the mark never overstates what did not happen.
    `index.ts` registers this executor before boot reconciliation.
  - `commitSyncOperation.ts` ([Task-368](pa://task/368),
    [Task-596](pa://task/596)) owns `commit-sync`, `commit`, and `base-sync`.
    All validate the deterministic reservation, active run/worktree/Project
    identity, exact repository, and checked-out branches. Initial `commit-sync`
    composes `runCommitWorkflow` (never forced), main `pull-rebase`, and run
    `rebase-main`; fix-round `commit` uses the checked commit path only and
    retains the latest accepted checkpoint base; `base-sync` requires a clean
    head, refreshes main, and rebases only when that checkpoint moved. The
    commit-only path proves the checkpoint exists and is an ancestor, while all
    paths require the expected clean final branch and derive the exact range. It
    also records the range's bounded change evidence (totals, per-file stat
    capped at 40, commit subjects) — best effort, since the range is the
    contract and a failed inspection must not fail a landed commit — because the
    pure recipe cannot read a diff and the coordinator's review decision needs
    one. The operation itself writes no workflow rows. Its `retry-safe` recovery
    converges by treating the commit workflow's exact no-changes result as an
    observation, repeating sync, and recomputing the range; a semantic-retry
    successor is accepted as the same reservation only when its failed/blocked
    commit-sync predecessor carries that exact idempotency key. Safety blockers
    and restored rebase conflicts remain visible blocked outcomes. `index.ts`
    registers it beside the agent executor before boot reconciliation.
  - `deliveryOperations.ts` owns the retry-safe outward workflow operations.
    `observe-ci` resolves a configured provider before pushing (so no remote
    means no push), pushes only the recorded run branch, reserves/adopts one
    draft PR card on the first push, and polls per-check provider evidence for
    the exact commit until green, red, no checks, or the configured timeout. A
    rejected run-branch push (early or at publication) recovers exactly one case
    itself: when the remote tip is a head a prior completed range operation or
    CI observation of the same run recorded — a synchronization checkpoint's
    rebase produced the rewrite — it retries under a force-with-lease on that
    exact oid; any other remote tip keeps the failure. Results and failure
    excerpts are bounded before persistence. Final publication repeats the clean
    exact-head gate, reuses that card, verifies remote head/base identity, then
    marks the same draft ready — GitHub through its GraphQL ready-for-review
    mutation, Forgejo by stripping one `WIP: ` prefix. The early-push opt-out
    leaves the prior create-at-delivery path intact.
  - `engine.ts` owns the advance loop (`advanceRun`), the lifecycle API
    (`pauseRun`/`resumeRun`/`cancelRun`/`retryRun`), the
    `(recipeId, recipeVersion)` recipe registry, and
    `reconcileWorkflowRunsOnBoot()` (wired in `index.ts` beside the other boot
    reconcilers). Admission is the reservation: the step row is appended before
    any side effect. Advances are serialized per run; pause and cancel
    deliberately are NOT, so a user action lands immediately, and an advance
    that then hits the store's pause gate holds on `WorkflowRunPausedError`
    while `WorkflowImmutableError` stays a bug and rethrows. Those two store
    refusals also propagate OUT of an executor's `dispatch` untranslated, so a
    pause landing while the executor prepares its session keeps the user's own
    pause reason instead of being overwritten by a dispatch error. Semantic
    retry appends a successor carrying a failed or blocked tail's exact
    assignment (including commit-sync's history-derived idempotency key) rather
    than reopening it; a pending dispatch failure only resumes its existing
    reservation. Resume changes only a paused run, so duplicate Resume commands
    on an active run append no event and dispatch nothing. Cancel preserves
    sessions, worktree, and PR. Completing a run is the engine's one statement
    about sessions: it hands the run id to `sessionActivity.ts` (imported at the
    call, not at module scope) so sessions the run never gave a checkout leave
    the Sessions inbox; code-delivery roles instead leave with the checkout.
    WHICH sessions settle stays that module's decision, and a failure there is
    logged rather than undoing the durable completion. Boot recovery consults
    the recipe FIRST — an unknown `(id, version)`, and any decision that comes
    back `pause` (a two-open-step history above all), pauses before a single
    running step is touched, so a stale or broken run never executes a side
    effect on the way to being paused — then pending steps re-dispatch, running
    agent steps are adopted when their session still exists
    (`observation-recorded`) and fail-and-pause when it is gone, and running
    operations follow their recovery policy — only `retry-safe` re-runs.
  - `runStart.ts` ([Task-366](pa://task/366)) is the start sheet's server side:
    `startCodeDeliveryRun` validates everything refusable FIRST, so a refused
    start creates nothing: unknown Task, no Project, no git-backed repo, and —
    because the config is a persisted authorization the step-4 executor replays,
    not just a shape — each role is RESOLVED against what is runnable now: the
    account must be a currently enabled credential profile of the model's
    provider family (an omitted account resolves to the automatic default and
    the resolved id is what gets stored), the model must be in that account's
    own offered list (`modelsForAccount` in `harnesses/models.ts`: the curated
    Claude list behind the claudeSdk gate, the account's pi registry otherwise —
    the same lists the sheet's pickers show), the thinking level must be one
    that model accepts, and prompt overrides are REJECTED over their bound
    rather than truncated. The four role sets are independently bounded by
    `WORKFLOW_ROLE_SET_BOUNDS` here and in `validateClientMessage.ts`:
    implementer/reviewer require 1..6 candidates, fixer/verdict allow 0..6.
    Candidate `family` and bounded optional `notes` are persisted and rendered
    as coordinator evidence; they never become hard family-routing rules; the
    coordinator picks a fixer and a verdict later, at the decisions that have
    their evidence, so the plan chooses only the implementer and the first
    reviewer. The run's two ceilings are normalized here and nothing is derived
    from them at start — sessions follow from them at run time. It then creates
    the run row with the resolved `CodeDeliveryWorkflowConfig` in the run's
    generic `config` column, then provisions the run worktree (naming agent with
    timestamp fallback, primary Jira key or `t<taskId>` branch prefix,
    `createWorktree` with the Task link), attaches it write-once, and hands over
    to `advanceRun`. The row-before-provisioning order is deliberate:
    provisioning can take minutes and fail, and a failure PAUSES the durable run
    naming the error instead of throwing. Progress streams through a `report`
    callback that `connection.ts` turns into `workflowRunStart` phase messages
    keyed by the sheet's `requestId`. The browser chooses the base before this
    call: nearest Task ancestor with an active same-Project worktree first, then
    the main checkout; this module validates every explicit branch either way.
- `projectProvision.ts` owns project repo SETUP and teardown via the user's
  ambient git+ssh: resolving `settings.projectsRoot/<project id>`
  (tilde-expanded) and cloning a project's `repoUrl` there (idempotent,
  `--recurse-submodules`). The clone dir is registered as the project's
  `localPath`, so it becomes the main checkout;
  `cloneAndRegisterProjectRepo(projectId)` is the shared clone+register core
  used by BOTH the browser `provisionProjectRepo` command and the agent's
  `project_registry_write` `cloneRepo` operation (callers own cache
  invalidation/broadcasts). It deliberately owns NO update path: keeping a
  checkout current is the worktree surface's job (`worktrees/worktreeSync.ts`
  `pull-rebase`, which works on the main checkout too and carries the
  submodule-update step this module used to own), so a project has exactly one
  repository lifecycle here — clone it, or remove it. No credential handling —
  relies on host git/ssh, but runs git with a non-interactive env
  (`PROVISION_ENV`: `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND` with
  `BatchMode=yes`/`StrictHostKeyChecking=accept-new`/`ConnectTimeout`) so a
  new-host/credential prompt fails fast with an error instead of hanging with no
  tty. Removal is the inverse (`deleteProjectRepoFolder`/`isManagedRepoDir`,
  orchestrated by `connection.onRemoveProjectRepo`): unregister the managed
  clone local path and delete the managed folder — `deleteProjectRepoFolder`
  refuses any path not contained under the projects root. That command REFUSES
  while spawned worktrees exist instead of force-removing them: removing a
  worktree may throw away unmerged work, so it stays an explicit per-worktree
  decision, and a checkout that is not a managed clone is refused with a pointer
  to Local paths. Client entries: the `provisionProjectRepo`/`removeProjectRepo`
  commands in `connection.ts` (both `console.error`-log failures for
  `journalctl`), each carrying only the project id; the client tracks the
  in-flight action in `useAssistant` state (`provisioning`) for the button
  spinner and keeps the last result in `provisionOutcome`, which `App.tsx` turns
  into a toast (a clone slow enough to outlive its own surface is the event
  case, and the toast is the only channel for it — there is no banner to reach
  for, per `docs/messaging.md`).
- `usageCache.ts` owns every provider subscription-usage snapshot: an in-memory
  map keyed by credential-profile id, persisted best-effort to
  `DATA_DIR/cache/usage/<profileId>.json` (tmp+rename, `0600`, corrupt-tolerant)
  so a restart does not blank the cards. Reads are served from memory and
  revalidated behind the request; `GET /api/usage/*` reads through it and
  `?refresh=1` forces plus writes through. An unforced read prefers an older
  snapshot over an error; a forced one reports the failure, because it is a user
  pressing Refresh. Fetches are single-flighted per account, with at most ONE
  Claude subprocess globally (the rest queue) and two concurrent OpenAI calls; a
  failure keeps the last good snapshot and backs off 1 → 5 → 15 min capped at
  30, timeouts included, because a logged-out Claude account hangs to its 20 s
  timeout. It NEVER fetches headlessly: the hub's broadcaster seam answers
  `hasClients()`, a finished run only marks its account dirty
  (`subscribeSessionRunCompleted` in `index.ts`, never the idle hook, which is a
  superset), and the next page open pays for the refresh. Snapshots reach
  browsers as the narrow `UsageIndicator` list on the `usage` broadcast topic —
  subscribing is the authoritative read — never as the raw snapshot. Deleting an
  account drops its entry and its file. Full contract: `docs/usage.md`.
- `credentialProfiles.ts` owns PA-local provider-profile metadata and private
  directories under `DATA_DIR/credential-profiles/`.
  `ASSISTANT_LEGACY_PI_AGENT_DIR` optionally overrides the one-time legacy pi
  seed source (a nonexistent path disables it for credential-free previews):
  profile metadata is atomic/mode `0600`; directories are `0700`; pi and Claude
  tokens remain in their provider-owned files and never cross this module's safe
  summary/API boundary. `claudeLoginTerminal.ts` owns the authenticated
  browser/mobile wrapper around the official bundled
  `claude auth login --claudeai` CLI: one reconnectable bounded process per
  profile, a minimal secret-free child environment, bounded/control-stripped
  output, direct unlogged stdin forwarding of the authorization code,
  timeout/cancel/deletion/shutdown cleanup, and no app-owned OAuth exchange.
  Protected default OpenAI and Claude profiles are created for ordinary and
  automatic session paths; they cannot be deleted but can be disabled once a
  secondary account should be the active default. Default Claude reflects and
  uses the service user's ordinary `~/.claude` login (no `CLAUDE_CONFIG_DIR`
  override), including in PR previews, while named profiles stay isolated.
  Disabled profiles remain resolvable for already-bound sessions but are
  ineligible for new sessions and omitted by new-session/Usage account surfaces;
  automatic profile selection takes the first enabled account in registry order.
  Every Claude SDK acquisition strips inherited provider credential/transport
  variables, then either lets Default Claude resolve normal `~/.claude` or
  injects the selected isolated `CLAUDE_CONFIG_DIR`. A changed hash of the
  profile-local OpenAI credential is the safe device-login completion signal
  because pi persists OAuth before its unbounded post-login model refresh
  settles; the hash is never projected. Non-default profiles can be renamed or
  deleted only when no session remains bound; deletion removes their private
  directory and tells provider runtime owners to invalidate in-flight work
  before late completion can restore files. `connection.ts` validates the
  selected enabled profile before pi's first prompt or review-handoff creation
  and immediately records its id in session metadata; message-level draft
  creation inherits and persists the source pi session's binding. Pi reopens
  through that same profile-local runtime. `credentialProfileUsage.ts` (separate
  module so the settings→slot-registry→profile-registry chain stays acyclic)
  projects what depends on one account — pinned settings slots, bound sessions,
  and whether it is the current automatic pick plus where that would move —
  behind `GET /api/credential-profiles?includeUsage=1`. A settings pin never
  blocks deletion: `DELETE` refuses only while sessions are bound, then
  `clearProfilePins` drops the account's pins and reports the affected slots.
- `settingsModelSlots.ts` owns the ONE inventory of configured model slots in
  `AppSettings` (helper one-shots, permanent assistant, memory processor,
  worktree naming/merge, day session, PDF fallback, minutes scanner) and the
  single resolver deciding which provider account each runs on. A slot's
  optional `credentialProfileId` pin is validated ONCE on write
  (`sanitizeSlotPinsDeep`, called by `updateSettings`: an unknown account or one
  of the wrong provider is never persisted; a pin to a temporarily disabled
  account survives). `resolveSlotAccount`/`accountForSlot` resolve at USE time
  and NEVER fail a run: a pin that is missing, disabled, or cross-provider
  degrades to the automatic account (first enabled account of that provider,
  `automaticProfileIdFor`), because disabling or deleting an account must not be
  able to break background automation. Unset means automatic. Every spawner and
  one-shot resolves through it, and pi model handles are then looked up with
  `findModelForProfile`/`selectPiModelWithFallback` in the SAME account that
  will run them — model availability is per account.
  `settingsModelSlots.test.ts` walks the settings tree for
  `{ provider, modelId }` objects and fails when one has no descriptor, so a new
  configurable agent cannot silently skip account support.
- `*Settings.ts` files own runtime integration settings for their `tools/`
  domain families; static deployment-level integration inputs are loaded through
  `config.ts`. Slack workspace metadata/read defaults, OAuth app client
  metadata, and the deployment-level Socket Mode app token are static config.
  Normal OAuth state/tokens live in `settings/slack.json`; experimental Huddle
  browser credentials live separately in `settings/slack-huddles.json` and
  retain only the browser token plus `d` cookie. `getSlackPublicApiConfig` and
  `getSlackToolConfig` never read or return that Huddle file; only
  `getSlackHuddleConfig` may project it to Huddle health/tool code.
- Jira and Tempo are two independent integrations (contract:
  `docs/jira-tempo.md`). `jiraSettings.ts` owns token/Basic auth
  (`settings/jira.json`: `enabled`, `atlassianEmail`, `atlassianToken`;
  `getJiraToolConfig`, `getJiraCredsIfAvailable`, `testJiraSettings`,
  `isJiraConfigured`); the Atlassian host is static config (`JIRA_HOST` in
  `config.ts`), not user-editable. The authenticated
  `GET /api/jira/issues?keys=…` read projection resolves up to 20 linked Task
  keys to current summaries and URLs, returning an empty list when Jira is
  unavailable so the inspector can degrade to key-only rows. `tempoSettings.ts`
  owns Tempo OAuth state (`settings/tempo.json`: `enabled`, `apiBaseUrl`,
  access/refresh tokens + OAuth state, cached `authorAccountId`); Tempo OAuth
  client id/secret are static config
  (`TEMPO_OAUTH_CLIENT_ID`/`TEMPO_OAUTH_CLIENT_SECRET`). `getTempoToolConfig()`
  (async) composes the Tempo bearer with Jira creds for enrichment (`jira` is
  null when Jira is off; Tempo tools degrade to raw issue ids, and
  `tempo_mutate_worklogs` requires Jira) and refreshes the OAuth token on demand
  via `ensureTempoAccessToken`. Tempo OAuth uses the authorization-code flow:
  `createTempoOAuthStartUrl`/`handleTempoOAuthCallback` back the
  `/api/tempo/oauth/{start,callback}` routes in `index.ts` (authorize is
  instance-hosted on `JIRA_HOST`; token is on `api.tempo.io`;
  connect/reauthorize = HTTP navigation, disconnect = `clearTokens` patch).
  Gates `jira` and `tempo` are independent in `agents.ts`.
- `gitHosting.ts` owns the provider-abstract git-hosting seam (Task 126):
  `parseRemoteUrl` (ssh/scp-like/https remotes → host+owner+repo) and
  `hostingProviderForRepo`, which detects the provider from a checkout's
  `origin` remote host — Forgejo when it matches the Forgejo integration's
  configured instance base URL (`getForgejoConfigIfAvailable()` —
  absent/disabled degrades the feature to off; Gitea-compatible API v1 via
  `forgejoClient.ts`, token required only for PR creation), and github.com via
  the existing GitHub PAT integration (`getGithubConfigIfAvailable()` —
  absent/disabled degrades the feature to off) implementing the same
  `GitHostingProvider` interface (find/create/merge PR, aggregate `ciStatus`
  plus normalized per-check `refChecks` via the shared
  `githubClient.githubRefChecks` / `forgejoClient.forgejoRefChecks` cores,
  `markPullRequestReady`, `pullRequestReview` for the standing review state, and
  `listOpenPullRequests` for the browse list). Draft creation uses GitHub's
  native field and Forgejo's merge-blocking `WIP: ` title convention; readying
  uses GitHub GraphQL and an idempotent Forgejo issue-title patch.
  `mergePullRequest` takes the head and (when deleting) the branch its caller
  already PROVED, plus the base that caller decided on. Proving both removes the
  provider's own pre-merge read — GitHub's existed only to learn which ref to
  delete — so nothing is read between the seam's identity check and the merge,
  where a retarget would keep the expected head and land elsewhere. A caller
  that proved neither gets exactly one read, on BOTH providers and whatever the
  delete choice: `resolveMergePreconditions` binds the decided base there,
  refuses a pull request that moved, and takes the head that read reported as
  the merge precondition, so every merge carries `sha`/`head_commit_id` and a
  pull request with no head commit refuses instead of merging unconditioned.
  `mergePullRequest` merges AND deletes the remote head branch in ONE seam call
  — GitHub as `PUT .../merge` then `DELETE /git/refs/heads/<branch>`, Forgejo as
  a single `POST .../merge` with `Do` + `delete_branch_after_merge` and a
  confirming branch read (Forgejo answers a merge identically whether or not a
  protected head branch survived it, and the card states the deletion as fact) —
  because a surface that merges usually wants the branch gone and two calls
  means two ways to leave a stale branch behind; `deleteBranch: false` is the
  caller's explicit opt-out and skips the deletion (and the confirming read)
  entirely, while omitting it still deletes. A refusal throws with the
  provider's own words (it is the authority on branch protection and required
  checks), while a failed branch deletion is reported without turning a landed
  merge into a failure. Provider calls now THROW when the API could not be
  reached or refused, returning `null` only when the answer is genuinely "there
  is nothing": swallowing a failure into `null` produced a payload saying "no
  PR, no CI", which is indistinguishable from a clean branch, so an outage
  rendered as a list of healthy-looking worktrees. `findPullRequestForBranch`
  also queries ALL states rather than only open ones — a MERGED pull request is
  the single signal that a branch's life is over, and `state=open` made that
  state unreachable; `pickBranchPull` prefers an open PR, else the most recent.
  `listOpenPullRequests` returns EVERYTHING open rather than only your own — it
  is one request either way, the ownership facts ride along in the same
  response, and the two consumers want different slices (the inbox takes what
  needs you, the Project page shows the repo). `changesRequestedFromReviews` is
  the shared rule behind that last one and is exported for its own test: only
  the LATEST review per person counts (a reviewer who objected and later
  approved has withdrawn the objection), stale/dismissed/pending/comment-only
  reviews never object, and the two providers' spellings (`REQUEST_CHANGES` vs
  `CHANGES_REQUESTED`) are normalized in one place. `closePullRequest` is the
  provider-neutral close-without-merging seam: both backends transition state to
  `closed` without a head precondition of their own, so the exact expected head
  and open state are proven by a read immediately BEFORE the write and the
  outcome by one after it — a refusal throws with the provider's message, and a
  landed-but-unconfirmed write comes back as `closed: false` with
  `unconfirmedReason` rather than an invented success. `repositoryCapabilities`
  reads what the repository allows (default branch, supported merge methods,
  optional default method, close and branch-deletion support) from provider
  metadata — GitHub's `allow_*_merge`/`delete_branch_on_merge`, Forgejo's
  differently spelled `allow_merge_commits`/`allow_rebase`/
  `default_merge_style`/`default_delete_branch_after_merge`, verified against
  its own API — and throws rather than answering "everything is allowed".
  Callers use `repositoryCapabilitiesFor`, which caches/coalesces per repository
  on a short TTL (`invalidateRepositoryCapabilities` obsoletes one or all, and
  `{ fresh: true }` is the forced read a merge takes) and turns a failed read
  into unknown-with-a-reason that is deliberately NOT cached. Cache entries and
  in-flight requests carry a GENERATION, so invalidating obsoletes work already
  in flight rather than only the settled value: a forced caller can neither join
  a pre-invalidation request nor be handed the answer it leaves behind. Absence
  is unknown everywhere and every consumer fails closed on it, and a single
  MISSING allow-flag leaves the whole method set unknown rather than advertising
  a guess. `findPullRequestsForBranch` is the multiplicity read behind managed
  finishing: its open set is paged until the provider is exhausted (an
  unexhausted read, or a page whose body is not a list, throws instead of
  answering), its terminal fallback costs a request only when nothing is open,
  and both it and the tolerant `findPullRequestForBranch` match on the head
  REPOSITORY, so a fork's identically named branch is never mistaken for this
  one. Worktree consumption goes through `worktrees/worktreeHosting.ts`.
- `pullRequestClose.ts` is the ONE projection of a pull request closed WITHOUT
  merging (`closePullRequestAndProject`), beside the merge projection and under
  the same `withPullRequestMutation` identity lock, matching cards through the
  shared `openCardsForPullRequest`. It revalidates open state, exact head and
  head/base identity, reserves card observation generations, closes once, then
  patches every matching live card to `closed` with the caller's reason, clears
  busy/error state (a card that left `open` stops being polled), invalidates
  worktree hosting caches and drives the ordinary workflow observation with the
  `closed` outcome. It never suggests the linked Task done, records a merge, or
  deletes any branch or worktree — closing abandons work rather than landing it
  — and an unconfirmed provider close stays an honest partial for the
  watcher/boot paths to reconcile.
- `forgejoSettings.ts` owns the Forgejo integration config
  (`settings/forgejo.json`: `enabled`, `baseUrl`, `token`, `defaultOwner`; token
  stored mode 0600, never echoed — public projection exposes
  `baseUrl`/`tokenConfigured` since only the token is secret). Forgejo is
  self-hosted, so the instance base URL is user config (not a fixed host like
  GitHub) and is the sole source — no static/env fallback.
  `getForgejoToolConfig()` gates on enable+baseUrl and throws a Settings hint
  otherwise; `getForgejoConfigIfAvailable()` returns the config or null for
  features that degrade silently (worktree PR/CI);
  `getForgejoBaseUrl()`/`getForgejoDefaultOwner()`/`isForgejoConfigured()` are
  helpers. The parsed file is cached in memory and refreshed by
  `updateForgejoSettings` (the only in-process writer), because
  `getForgejoBaseUrl()` sits on read paths that run per Task link — Task
  external-link classification called it once per link, turning a list into a
  file read + parse per link. `testForgejoSettings()` probes `/version` and,
  when a token is set, `/user` to surface the resolved `login` + server
  `version`. `forgejoClient.ts` is the hand-rolled `fetch` wrapper (no SDK):
  Gitea `Authorization: token …` auth, `<baseUrl>/api/v1` root derived via
  `normalizeForgejoBaseUrl` (trims trailing slash + redundant `/api/v1`),
  `X-Total-Count` surfacing, `page`/`limit` pagination (`forgejoPaginate`, which
  also reports the FIRST page's `X-Total-Count` — it counts the whole result
  set, so later pages cannot change it), an opt-in `raw` mode that reads the
  response as text for Gitea's `.diff`/`.patch` endpoints, and the
  per-instance+token cached `resolveForgejoLogin` (`/user`, so a PR list that
  asks "is this mine?" per row costs one probe; `null` when anonymous or
  unreachable, and callers must degrade rather than treat an unknown identity as
  ownership). It also holds the shared `forgejoRefChecks` ref-CI aggregator
  reused by `gitHosting.ts` and the `forgejo_get_ref_checks` tool — the twin of
  `githubRefChecks`, but ONE endpoint (the combined `/commits/{ref}/status`)
  because Forgejo has no check-runs concept and Actions jobs report as ordinary
  commit statuses. Two quirks are absorbed there rather than at each call site:
  the body's `total_count` counts the PAGE, not the ref, so the true total comes
  from `X-Total-Count` and a `truncated` flag says outright when the rolled-up
  state was decided on less than all of it; and `target_url` on an Actions
  status is instance-RELATIVE, so `absoluteForgejoUrl` resolves it against the
  base URL. The `forgejo` tool gate is `isForgejoConfigured()` (enabled + a base
  URL), which is what switches the `forgejo-repositories`,
  `forgejo-collaboration`, `forgejo-content`, `forgejo-ci`, and
  `forgejo-pr-writes` catalog groups.
- `githubSettings.ts` owns the GitHub integration config
  (`settings/github.json`: `enabled`, `token`, `defaultOwner`,
  `packageProxyEnabled`; token stored mode 0600, never echoed — public
  projection exposes only `tokenConfigured`). `getGithubToolConfig()` gates on
  enable+token and throws a Settings hint otherwise;
  `getGithubConfigIfAvailable()` returns the config or null for features that
  degrade silently (worktree CI);
  `getGithubDefaultOwner()`/`isGithubConfigured()` are helpers;
  `testGithubSettings()` validates via `/user` and surfaces the resolved
  `login` + token `scopes`, and appends BOTH the container-pull readiness
  sentence (runtime availability + whether the token carries `read:packages`)
  AND the package-proxy readiness sentence (lazy-imported from `packageProxy/`
  to avoid a settings↔proxy cycle) so ONE check diagnoses GitHub API, GHCR
  pulls, and package-registry resolution together.
  `getGithubRegistryCredential()` is the single server-side-only credential
  projection consumed by BOTH `containerImages.ts` (GHCR) and `packageProxy/`
  (Maven/npm/NuGet package registries); it is never part of any
  client/tool/agent-visible shape. `githubClient.ts` is the hand-rolled `fetch`
  wrapper (no Octokit): classic-PAT Bearer auth, pinned `X-GitHub-Api-Version`,
  `Link` rel="next" pagination (`githubPaginate`), the per-token cached
  `resolveAuthenticatedLogin` (`/user`, shared by `github_org_activity` and the
  registry credential), surfaced rate-limit/scopes headers, and the shared
  `githubRefChecks` ref-CI aggregator reused by `gitHosting.ts` and the
  `github_get_ref_checks` tool. The API base is the fixed `GITHUB_API_BASE`
  (github.com), not user-editable. Gate `github` is independent in `agents.ts`.
- `containerImages.ts` owns server-side container image pulls — the ONE place
  allowed to hand registry credentials to the `docker` CLI (contract:
  `docs/container-images.md`). Agent shells get no registry credentials: the
  `container_image_pull` tool pulls here, and the image lands in the host-global
  Docker store so a worktree build uses it with no token in its environment,
  argv, or transcript. Invariants (guarded by `containerImages.test.ts`): a
  credential is used ONLY for `GHCR_REGISTRY` (any other registry is anonymous
  even when a provider is passed); the token reaches
  `docker login --password-stdin` on stdin only; every invocation runs against a
  fresh 0700 temp `DOCKER_CONFIG` (bypassing `~/.docker/config.json` and
  credential helpers) removed in a `finally` on success/failure/timeout/abort;
  and all surfaced text goes through `redactRegistrySecrets` bounded to the last
  lines. `parseImageRef` normalizes and hard-validates references (printable
  ASCII, no leading `-`, strict grammar) and pulls run as
  `docker pull -- <ref>`. Same-reference pulls dedupe in-flight, at most two run
  concurrently, and already-present images short-circuit without touching
  credentials. `setContainerExecForTests` is the single docker exec seam; the
  credential arrives as an injected provider, so this module never imports
  settings.
- `containerResidue.ts` is the one place the app RUNS a container instead of
  pulling one (Task 659): when a removal finds a directory owned by another uid
  — a bind-mounted container that wrote as root — it asks the daemon, already
  effective root, to `chown -R` the tree back to the server's own uid/gid. It
  shares `containerImages.ts`'s `execContainerCommand` seam and carries no
  credentials. Invariants (`containerResidue.test.ts`): the path is app-derived
  and must resolve strictly inside a configured worktree root (a root itself,
  anything outside, or a vanished path is refused before any docker call); one
  mount at `/target`, no network, no env, no stdin, bounded timeout; the
  ownership is this process's own, with no parameter that could name another
  user; it chowns rather than deletes, so deletion stays on the host with its
  git guards; and the expected `st_dev`/`st_ino` pair is checked INSIDE the
  container after the mount (a bind mount preserves both; an inode alone would
  not identify a directory, since `/dev`, `/proc` and every tmpfs hold inode 1),
  which is what defeats a rename plus symlink swap between the host-side check
  and the daemon's mount. Every failure is an `unavailable` reason to show
  beside the `sudo` fallback, never an exception.
- `managedTreeRemoval.ts` owns deleting a tree the app owns when something else
  wrote into it: a bounded, shallow-first scan that separates OWNER-LOCKED
  directories (ours, mode-locked — repaired with the fd-based
  `restoreOwnerAccess` that `agentTempTree.ts` also uses) from FOREIGN-OWNED
  ones (another uid — only the runtime or `sudo` helps), and a removal ladder of
  rm, owner repair, reclaim, rm. Running as uid 0 reports nothing, since root
  deletes either way.
- `pendingApprovals.ts` owns the unified, harness-neutral approval subsystem
  (Task 108) behind every agent-proposed mutation: GitHub PR writes (kind
  `githubPullRequest`), Jira issue edits (`jiraIssue`), and Tempo worklog writes
  (`tempoWorklog`). (The `/commit --dry` accept flow deliberately stays on its
  own host-command `CommitDisplay` card — it is a user slash command, not an
  agent-proposed mutation, and its rich durable `command.result` history would
  regress if forced onto the generic card.) It mirrors the question flow's six
  properties: a durable per-session store (SQLite, `db/approvalStore.ts`) with
  lifecycle `pending → executing → executed | failed | rejected`; cards
  interleaved into BOTH harnesses' `snapshot()` (`withApprovalBlocks`) AND
  re-emitted to a viewer on attach (`connection.view` → `approvalsForSession`)
  so they survive reload at the tool/time position where issued
  (`ApprovalCard.sourceToolCallId`, timestamp fallback for legacy cards) instead
  of collecting at chat bottom; a pending approval marks the session
  `awaitingInput`/`idleReason:"awaiting_approval"` (same sidebar attention as a
  question) via `hasPendingApproval` + `subscribePendingApprovalChanges` (both
  harnesses subscribe + rebroadcast, `sessions.ts` reads it for the list badge;
  `pullRequestCards.ts` mirrors that pair for a `choosing-task` card).
  `createApproval` stages a `pending` card; execution happens ONLY on
  `resolveApproval(id, "approved", edits?)` through a per-kind
  `registerApprovalExecutor` (throws → `failed`), preserving the
  executor-mutated body on BOTH success and failure so partial ids/per-item
  diagnostics are not lost (`reconcileLegacyPartialApprovalCard` also
  deterministically repairs the old Jira post-create-link failure shape from its
  retained `KEY↔target` error), and `resolveApproval(id, "rejected")` records
  the rejection. Either way `connection.onResolveApproval` resumes the idle
  session with a hidden outcome prompt (`APPROVAL_OUTCOME_MARKER`, via the
  runtime facade like a question answer) so the agent learns the decision.
  `broadcastApprovalUpdate` (hub) pushes lifecycle updates;
  `setApprovalBroadcastForTests` is the test seam. Approve/Reject is one
  `connection.ts` command (`resolveApproval`), never a harness accept-mutation
  method — so it works identically on pi and claude-sdk. If a stale client
  re-submits a decision for an already-resolved card, `connection.ts` re-sends
  the current authoritative card before reporting the error so the browser
  cannot remain on a false pending/spinning state. `pullRequestCards.ts`
  (Task 323) mirrors this whole shape for `/pr`'s live card — durable store,
  snapshot injection, `sourceToolCallId` anchoring, stale-decision re-send — but
  has no executor registry: `prWorkflow.ts`'s `finalizePullRequestCard` drafts
  and creates the pull request directly, and `pullRequestWatcher.ts` patches
  CI/review/mergeability on its own poll cadence rather than on a single user
  decision; its stage-3 actions live in `pullRequestActions.ts`. An executor may
  also implement `prepare(card, edits)`, the one seam for a card the USER edits
  before approving: it runs and is persisted while the card is still `pending`,
  so a refusal leaves something they can correct rather than a half-executed
  write. It runs on EVERY approval, with or without edits — a card can sit
  pending while the world moves under it, so untouched rows need revalidating
  too. `sessionSpawn` is its only implementer today. Because `prepare` and
  `execute` both await, `pending` is not a claim: decisions for one approval are
  serialized through an in-process `decisionLocks` map (the pattern
  `peerPrompt.ts` uses for `drainLocks`) so two clients cannot both pass the
  pending check and execute twice, and an approve parked in `prepare` cannot
  resume past a completed reject and run what the user refused. The loser
  re-reads the resolved card and is told its state; a `prepare` that throws
  still leaves the card pending.
- `sessionSpawn.ts` owns agent-spawned peer sessions
  ([Task-553](pa://task/553)): `session_spawn` proposes a batch of new sessions,
  and ONE approval card decides them. Authority is split on purpose — the agent
  owns the title, persona, target worktree/project/Task and opening prompt, so a
  mistake there throws a `SpawnProposalError` and writes no card, while the user
  owns account, model, thinking and whether a row runs at all. An agent's model
  hint is therefore resolved for display only: `resolveRuntime` tries the hint
  (either of `provider`/`modelId` alone counts as one), then the proposer's own
  runtime, then any enabled account's first model, recording a `modelWarning`
  instead of failing; `clampThinking` only ever moves a level DOWN its model's
  ladder, so a hint can never buy more thinking than it asked for.
  `prepareSpawnApproval` is the `prepare` seam and does two jobs: fold in the
  user's edits, then PROVE every row that will execute still runs — account
  enabled, provider family matched, model still offered by that account,
  thinking clamped. Untouched rows are checked as strictly as edited ones, since
  neither the agent's proposal nor a browser payload is evidence that a runtime
  is still available; a failure keeps the card pending so the user re-picks or
  skips that row. Worktrees resolve through `resolveWorktreeRow`, never the
  DB-only `getWorktree`: a project's MAIN checkout is the synthetic
  `main:<projectId>` row an agent copies out of `worktree_status`, and both its
  checkout path and a spawned row's are proven to exist. Execution creates
  through `harnesses/create.ts` `createSession`, as `workflow/agentExecutor.ts`
  does, and the title it sets BEFORE the first prompt is what suppresses
  auto-naming on both engines. The opening prompt then goes out through
  `sendPeerPrompt` from the proposing session: that gives the new session a peer
  to answer and, having no shared history, opens a fresh conversation and chain
  with a full hop budget. Its Project and Task context comes from the shared
  `sessionContext.ts` seam like every other trigger's; the peer envelope has no
  attachment slot, so delivery rebuilds it from the links
  ([Task-554](pa://task/554)). The row's OWN Project wins over the worktree's —
  what lets one agent drive a cross-project epic — and it is resolved once, at
  proposal time: execution uses the card's Project rather than re-deriving it,
  so what the user approved is what the session gets. A Project the agent named
  that is not in the registry fails the proposal; one inherited from a worktree
  whose registry entry is missing is dropped instead, since an unregistered id
  carries no context and the row was never about that Project. Ordering inside a
  row is a safety property: every dependency the row's context or delivery rests
  on — worktree, Task, Project — is revalidated BEFORE creation, because nothing
  can be cleanly undone afterwards, and `resultSessionId` is written the instant
  the session exists so a failed delivery reports a row with both an id and an
  error rather than an orphan in the sidebar. Rows are isolated — one failure
  annotates its own item and the batch continues — and the new session ids ride
  in `resultSummary`, which is what the outcome prompt hands the agent. These
  are `scope = 'user'` sessions, NOT subagents; nothing here touches the
  subagent registry. `spawnApprovedPeers` is the DIRECT path
  ([Task-595](pa://task/595)): the same `validateStructure` gate, the same
  `spawnOne` creation/link/context/delivery seam, but the runtime comes from the
  user's approved roster instead of a card. Structural mistakes fail the whole
  batch before anything exists (they are the agent's to fix); from there each
  row resolves its own approved runtime, and then `spawnOne` RE-resolves it
  through the `currentRuntime` hook as the last read before the creation side
  effect. Both are needed: the early one keeps a roster mistake cheap, and the
  late one is the authoritative read, because the awaits in between (worktree,
  Task and Project revalidation) are exactly where a Settings save lands — a
  runtime resolved before them is a claim about the past. A row disabled or
  removed in that window is refused, a row re-pointed runs on the CURRENT
  approval, and the result reports the runtime it actually started on. Nothing
  yields to the event loop between that hook and `deps.create*`. A runtime,
  creation or delivery failure annotates that row while the rest continue.
  `responseRequested` defaults to TRUE here — the coordinator owns closure on
  this path — and the opening prompt goes out through `withReportingRoute`, so
  the child is told who to answer even when the coordinator forgot to say it.
  The batch runs under one concurrency claim, released in a `finally`.
- `peerSpawnRuntimes.ts` owns the approved peer-runtime roster
  ([Task-595](pa://task/595)) — the user's standing permission for agents to
  start ordinary peer sessions without a card per batch. `peerRuntimeRoster`
  projects `settings.peerSpawnRuntimes` in the user's order with each row's real
  availability, host-inferred family, and user-set relative cost plus optional
  selection description; an unavailable row stays LISTED with its reason, since
  a vanished option is worse to reason about than a broken one.
  `resolveApprovedPeerRuntime` is the only way onto the direct path and never
  degrades: an unknown id, a disabled row, a withdrawn model or a thinking level
  the model dropped each throw `PeerRuntimeRefusedError`, because every
  plausible recovery — nearest model, automatic account, "propose it instead" —
  silently widens what an agent may spend on. `admitDirectPeerTurns` is a fixed
  policy (`MAX_CONCURRENT_DIRECT_PEER_TURNS`, not a setting) and counts a
  coordinator's own direct child while its runtime is RUNNING **or** while a
  prompt that coordinator sent it is still queued or dispatching
  (`peerPromptStore.unfinishedTurnCount`). Both halves are load-bearing:
  delivery only ENQUEUES the opening prompt and drains it in the background, so
  runtime state alone is blind for the whole create-to-first-turn window and the
  next call would be handed a full fresh quota, while the queue alone would miss
  a turn already under way. The queue is a durable self-clearing signal rather
  than a timer — every delivery ends terminal or post-turn, and a retry
  re-enters as `queued` — so no slot leaks for a start that never happens, and
  an answered or forgotten child still frees its slot. On top of that, admission
  CLAIMS the slots it grants and returns them as a handle the caller releases,
  with the count-then-claim pair in one per-coordinator critical section: the
  check awaits runtime state, and a second batch arriving during that await
  would otherwise be told the same slots are free. The claim covers the window
  before the children exist at all; the queue covers the window after they do.
  The return route (`withReportingRoute`) is server-owned in the same spirit: a
  caller's text can never suppress it — a previously generated block is stripped
  and exactly one block naming the CURRENT coordinator is appended, so quoting
  the marker sentence or pasting another coordinator's suffix changes nothing.
  Nothing here imports the subagent domain; `architecture.test.ts` holds that
  line. `peerSpawnRuntimes` is also the one ARRAY-valued settings section, and a
  patch REPLACES the whole roster, so `validateClientMessage.ts` checks it
  explicitly (array, plain-object rows, `id`/`modelId` present, kind-checked
  leaves, `relativeCost` in its four-value vocabulary, and `description` within
  `MAX_PEER_RUNTIME_DESCRIPTION_CHARS`). `thinkingLevel` is kind-checked only,
  because a patch replaces the WHOLE roster and a vocabulary check there cannot
  tell a client inventing a level from one preserving what a legacy row already
  stores — it would freeze renaming, enabling or re-modelling that row behind
  replacing its level, the opposite of retaining it for repair. Settings store
  that leaf VERBATIM, and `peerRuntimeUnavailableReason` plus
  `resolveApprovedPeerRuntime` stop an unrecognized level from ever running.
  Cost is stricter safely because read normalization maps an absent or invalid
  legacy label to `unknown`, so no legitimate round trip has an invalid value to
  preserve. The normalizer also bounds descriptions while retaining their text
  verbatim so server echoes cannot consume a space mid-typing; the roster
  projection trims and collapses whitespace before exposing a one-line hint to a
  model. `updateSettings` applies the roster only when it really is an array.
  Both guards exist because the normalizer answers "not an array" with an empty
  list: without them a malformed patch would not be an error, it would silently
  delete every approval the user granted. An EMPTY array stays a legitimate
  patch — that is how the last row is removed.
- `sessionContext.ts` is the ONE place that decides what context a session
  starts with ([Task-554](pa://task/554)): started from a Task, from a Knowledge
  Base entry, or on a plain Project. Five triggers used to carry their own copy
  of that block — three in `connection.ts` (ordinary send, pi first send, claude
  first send), `workflow/agentExecutor.ts`, `sessionSpawn.ts` — and the copies
  had drifted: one had no worktree fallback for the Project, and the claude one
  INLINED Knowledge context into the prompt text while the others attached it.
  The operation is split around session creation on purpose:
  `resolveSessionContext` is a pure read settling precedence (Task > Knowledge >
  Project, the Project defaulting to `worktreeProjectId` when the caller offers
  one) and yields the `sessionContextEvidence` the prompt conditions freeze;
  `applySessionContext` then writes the links and returns the attachments. That
  split is a safety property — the evidence is a CLAIM that the matching
  attachment ships (a known Project drops the eager registry pointer on exactly
  that promise), so deriving both from one resolution makes the disagreement
  unrepresentable. Context always travels as an ATTACHMENT
  (`promptAttachments.ts` reaches the model on BOTH harnesses while the durable
  log keeps the human's words), which is why the second KB rendering path is
  gone. The resolution stays authoritative at apply time too: creation happens
  in between, so a Task that moved Project is attached under the Project the
  session was born claiming, and a Task deleted in that window leaves that
  Project's own context in its place — the frozen evidence cannot move, so the
  attachment is reconciled toward it. `sessionFirstTurnContext` rebuilds the
  same payload from a session's persisted links for a trigger whose first turn
  happens later and elsewhere — peer delivery of an agent-spawned session — so
  nothing has to be carried across a restart. That deferred rebuild is why
  `applySessionContext` takes `pinProject`: a spawned session's Project is
  pinned at start (the `in_project` edge) so the rebuild cannot hand it a
  Project the evidence never claimed, while every immediate trigger keeps the
  live behaviour where a Task start follows its Task's Project. Knowledge
  context is deliberately absent there: no trigger defers the first turn of a
  KB-started session.
- `documentConversion.ts` owns harness-neutral PDF → Markdown conversion for the
  `convert_pdf` tool: born-digital PDFs convert offline via `unpdf` (pdfjs; page
  count + text-layer read) and `@opendocsg/pdf2md` (Markdown), while a
  scanned/empty-text-layer PDF routes to an injected `setPdfClaudeFallback` seam
  capped at `CLAUDE_FALLBACK_MAX_PAGES` (30) pages. Each pdfjs consumer gets its
  own fresh byte copy (pdfjs detaches the buffer). The fallback seam may return
  null to decline (disabled/empty) so the caller degrades to low-text + a note.
  Pure `@anthropic-ai`-free (usable from `tools/`).
- `pdfClaudeFallback.ts` wires that fallback seam to the Claude Agent SDK: it
  sends the PDF as a Claude document block through `runOneShot`
  (`harnesses/oneShot.ts`, `documents`), using the `pdfConversion` app settings
  (`fallbackEnabled` master switch, model/thinkingLevel/timeout).
  `registerPdfClaudeFallback()` is called once at startup in `index.ts`;
  credentials are whatever the Claude SDK already uses.
- `sessionAttachments.ts` owns the addressable per-session attachment store
  under `DATA_DIR/attachments/<sessionId>/`: uploaded prompt files and
  server-staged binaries (e.g. `slack_file_read` downloads), tracked in an
  `index.json` sidecar with a directory-scan fallback that keeps
  pre-index/legacy files discoverable. Bytes move BY REFERENCE (an attachment
  id) into KB assets (`kb_add_asset` `sourceAttachmentId`) or bounded reads
  (`list_attachments`/`read_attachment`), never through the model context;
  resolution is path-contained under the session dir.
- `promptAttachments.ts` owns the harness-neutral model-facing prompt-attachment
  builder shared by both harnesses (`PiLiveSession` and `ClaudeSdkSession`): it
  persists every uploaded prompt attachment to `sessionAttachments`, threads
  images to the model as image content blocks, and represents non-image files in
  a prompt suffix (inline decoded text for text-like files, otherwise a
  saved-path reference the model reads via `read_attachment`/copies via
  `kb_add_asset`) led by a comment-wrapped manifest. Display/durable attachment
  chips are recorded separately by the runtime from the structured
  `PromptAttachment` list.
- `slackUrls.ts` owns the canonical Slack private-download host classifier
  shared by documented file reads and shortcut-intake URL filtering; keep those
  paths on the same allow/deny boundary.
- `slackSocketMode.ts` owns the always-on outbound Slack Socket Mode transport:
  opening app connections, immediate envelope acknowledgement, a 1 MB inbound
  payload ceiling, workspace/user validation, retry de-duplication, reconnect
  backoff, handler subscriptions, runtime enable reconciliation, and graceful
  stop. Domain consumers such as private bot chat and message-shortcut intake
  subscribe to it; they do not own WebSockets. Connection lifecycle is traced on
  the `[slack-socket]` log prefix so a reconnect flap is diagnosable from the
  journal: every `connected`/`closed` pair carries a monotonic `connection=`
  sequence, `closed` adds the close code, reason and socket lifetime, socket
  errors are logged as well as recorded on the status, and Slack's `hello` and
  `disconnect` envelopes log their `num_connections` /
  `approximate_connection_time` and `reason`.
- `permanentAssistant.ts` owns singleton-session acquisition (creating fresh
  sessions with the dedicated `personal-assistant` persona under both harnesses)
  and sequential draining of the durable cross-channel inbox in
  `db/permanentAssistantStore.ts`; channel adapters enqueue with stable
  deduplication keys and subscribe for delivery updates rather than prompting
  the runtime directly. A legacy binding that still points at an ordinary
  `assistant` session is abandoned (binding cleared, old conversation left
  intact as ordinary history) so the next open acquires a fresh
  `personal-assistant` singleton. `permanentAssistantProfile.ts` turns the
  configured name and additive instructions into session-fixed system-prompt
  instructions for both harnesses. Queued web prompts retain their client
  request ID and all user-authored queue inputs use human prompt origin so
  optimistic transcript entries reconcile in place. Delivery updates reach only
  the connection VIEWING that session, and carry its `sessionId` beside the
  client request id: the client renders `queued`/`working` as conditions on that
  prompt's own row and routes `failed` to the session it names
  (`docs/messaging.md`). The order matters and is a contract — `working` is
  emitted before the run whose durable user entry retires that row. The
  singleton is excluded from every session-list message a client receives,
  matched by PERSONA (`sessionListHiddenProbe`, one binding read per projection)
  rather than only by the currently bound id: the window between minting a
  session and binding it, and the predecessor a profile-change rotation leaves
  behind, are `personal-assistant` sessions too and the persona belongs behind
  its own entry point rather than in a list. That has a product consequence
  worth knowing: `rotatePermanentAssistantSession` runs on ANY Personal
  Assistant profile edit (name, provider, model, thinking level, instructions),
  and the predecessor it abandons keeps its conversation on disk and reachable
  by id — a `/sessions/<id>` deep link, the session tools — but is no longer
  listed anywhere, and `/assistant` always resolves the currently bound
  singleton. A legacy binding to an `assistant`-typed session stays hidden only
  while it IS the binding, then returns to ordinary listed history.
- `peerPrompt.ts` owns the server-owned peer-prompt engine behind
  `tools/sessionSendPromptTool.ts`: target resolution (rejecting a target with
  NO live driver AND no resumable on-disk state, not just
  deleted/internal/archived, so a message can never queue forever with no
  delivery path), conversation/causal-chain routing with automatic reply
  correlation (active delivery context, else a unique unreplied
  `responseRequested` request; ambiguity starts fresh), persistence via
  `db/peerPromptStore.ts`'s atomic `enqueueRouted`, and non-interrupting
  delivery. Delivery claims one FIFO same-sender/same-conversation batch (≤5
  msgs/16000 chars; the recipient card's `responseRequested` reflects ANY
  batched message, not just the head), builds a ≤300-char-overhead
  agent-provenance envelope with a desensitized fixed `PromptOrigin.agentId`
  (the real sender identity stays in the sanitized card's `senderTitle` and
  server-side store, never in the ordinary origin projection), and drives the
  recipient runtime through the `runtimePrompt` facade — never
  steering/interrupting a running target. Draining is browser-independent: it
  fires on enqueue, on session open, on every runtime running→idle transition
  (the `liveSession` `setSessionIdleHook` seam, so permanent-assistant/etc. runs
  trigger it), via `drainAllQueuedOnBoot` at startup, and via
  `sweepPeerPromptRetries`/`sweepExpiredLeases` (both wired at boot AND on a
  `RETRY_SWEEP_INTERVAL_MS` interval in `index.ts` — guarded by
  `peerPromptWiring.test.ts`'s static source assertion so the wiring cannot
  silently regress) which are the ONLY paths back from a scheduled
  `retryable_failed` backoff or a hung in-process dispatch lease, respectively.
  Graceful shutdown flips this off: `index.ts`'s `requestGracefulShutdown` calls
  `stopPeerPromptDelivery` so `drainRecipient` starts no new batch (and
  cold-resumes no target) while the server drains — otherwise the idle hook
  keeps re-driving idle sessions from the queue, `runningCount()` never reaches
  zero, and `nixos-rebuild switch` blocks on the app stop until the force
  timeout (a hanging deploy); the wiring is guarded by
  `peerPromptWiring.test.ts`, and queued rows resume on next boot via
  `drainAllQueuedOnBoot`. A post-admission provider failure is `interrupted`
  with `interruption_kind = 'failure'` (never re-injected); a pre-admission
  failure (busy-race, transient resume/acquire failure) is `retryOrFail`-bounded
  — retryable with exponential backoff up to `RETRY_MAX_ATTEMPTS`, then
  permanently `failed`. Admission is idempotent against the recipient canonical
  log: the delivered entry persists EVERY batched row's key (`peerMessageIds`),
  so `recoverPeerPromptsOnBoot` detects each row (not just the head) and
  broadcasts a card update whether it lands back at `queued` or is escalated to
  `interrupted`. Boot recovery covers BOTH crash windows Task 88 calls out:
  `dispatching` rows (never reached admission) decide `queued` or `interrupted`
  against the recipient-log check above, and rows already
  `admitted`/`acknowledged` (admitted, but the process died before run
  completion) unconditionally become `interrupted` via `recoverStrandedAdmitted`
  — never re-queued, since admission already happened and re-queuing would
  re-inject a second visible prompt. Every row a RESTART interrupts is stamped
  `interruption_kind = 'restart'`, which is what the sender notice keys on:
  `drainRecipient` flushes the FIFO queue first and then calls
  `deliverInterruptionNotice`, waking the SENDER of any `restart`-class row that
  asked for a reply with one turn naming the recipient session ids. A
  `failure`-class row never produces one. `sender_notified_at_ms` is written
  only after that turn is accepted, and a crash mid-notice re-notifies rather
  than losing the only warning. A REFUSED notice schedules its own bounded
  backoff retry (`NOTICE_RETRY_MAX_ATTEMPTS`, cleared on delivery and by
  `stopPeerPromptDelivery`) because nothing else comes back for it: the runtime
  fires its idle hook from inside `LiveRuntimeSession.prompt`'s `finally`, while
  `drainLocks` still holds that session, so the hook's own `drainRecipient`
  coalesces onto the failing drain and starts nothing. A resume/acquire failure
  schedules it too (`noteDrainTargetUnavailable`), because a notice has no
  queued row behind it and `markResumeFailureRetryable` therefore claims an
  empty batch and records nothing — leaving a cold sender, which is what boot is
  for, with no trigger at all. The notice also sends NO `clientRequestId` — an
  ordinary prompt claims that dedup key BEFORE reaching the provider and keeps
  it when the provider then fails (only the steer-only path releases it), so a
  stable key would answer the retry "already handled" and mark a delivery that
  never happened. Senders owing one are added to `drainAllQueuedOnBoot`'s target
  set because the restart that stranded them typically left them cold, with
  nothing queued and no idle hook to reach them. The `dispatching`-row decision
  and its write are NEVER split across two separate commits:
  `recoverPeerPromptsOnBoot` reads `db/peerPromptStore.ts`'s read-only
  `listDispatching()`, decides each row's fate (against the log) WITHOUT writing
  anything, then commits ALL decisions through `applyRecoveryDecisions` in ONE
  transaction — every row moves DIRECTLY `dispatching` → its final status, never
  through an intermediate committed `queued` state for a row that turns out to
  already be admitted. A two-phase commit (`dispatching`→`queued` always, THEN
  separately maybe →`interrupted`) would leave that intermediate "queued but
  already canonically admitted" state durably committed after a crash between
  the two commits — invisible to every later boot scan, and something ordinary
  drain/retry logic could misinterpret as never having been delivered.
  `markResumeFailureRetryable` (the acquisition-failure path) defends against
  that same "queued but admitted" combination too, however it might arise: it
  checks the log before retrying/failing a freshly-claimed batch and, if already
  admitted, restores grouping and interrupts it the same way boot recovery would
  — without ever needing to acquire the target. The canonical log append (with
  `peerMessageIds`, the batch's full admission-key list) happens BEFORE our own
  `batch_head_id` bookkeeping, so a crash in that exact window is closed by
  `findAdmittedBatch`: it parses the recipient's log entry itself to recover the
  true batch composition (`peerMessageIds[0]` is always the head, since delivery
  persists it head-first) and restores `batch_head_id` before reconciling,
  rather than permanently splitting one canonical card into unmatchable per-row
  entries. `broadcastCardUpdateFor` is THE one centralized, batch-aware
  broadcaster every lifecycle path (delivery, reply correlation, expiry, boot
  recovery, retry/lease sweeps) drives its card updates through: the sender's
  own per-message card always shows its own true state at `opaqueKey(m.id)`; the
  recipient's card looks up the row's COMPLETE batch membership via
  `db/peerPromptStore.ts`'s `listByBatchHead` (by durable `batch_head_id`, set
  once at admission via `markDeliveryBatch`, never just whichever members a
  bounded/paginated window happens to include) and broadcasts one
  `AGGREGATE_STATE_PRIORITY`-ranked state at the batch's shared `batchCardKey` —
  never the row's own individual key, so an aggregate outcome can never bleed
  into another member's own sender-side card, and a batch straddling a history
  page boundary still reports its true, complete aggregate. A reply also
  re-broadcasts the original request's own card (via its `markRepliedId`) so the
  sender sees it flip to `replied` without a separate poll. `cardFor` fills the
  card's one real id, `peerSessionId` — the recipient on a sent card, the sender
  on a received one — so each transcript can link to the other half of the
  conversation. It is display data (it rides the log entry's `peerPrompt` field,
  never the entry content or origin the model reads), and neither side learns
  anything new from it: the sender named the target itself, and the reply cue
  already names the sender. Every other id (message, conversation, chain) stays
  opaque. `peerPromptThreadsFor(sessionId, limit?)` builds the bounded,
  sanitized per-session history projection (opaque keys, bounded transition
  `auditTrail`, no raw ids/paths) carried on `SessionState.peerPrompts`,
  grouping received batch rows the SAME `listByBatchHead`-complete way, and
  carrying `PeerPromptThread.peerSessionId` for the same reason `cardFor` does
  (the section links to that conversation);
  `requestPeerPromptHistory`/`peerPromptHistoryExpanded` let the client
  explicitly expand it up to `HISTORY_EXPANSION_MAX_MESSAGES`.
  `peerPromptAnchorFor(sessionId, messageKey)` answers the section's per-message
  jump: it finds the participant row whose VIEWER-side key matches, re-keys it
  for the peer (a sent row's copy is the recipient's shared `batchCardKey`, a
  received group's is the head's own `opaqueKey`) and locates that card in the
  peer's log through `sessionRuntime.locateAnchor` — which opens any session's
  log, live or not, and evicts it again unless something already held it.
  `runPeerPromptRetention` (boot + daily) expires unresolved replies after 30
  days and prunes terminal detail after 90 days, never touching unresolved rows.
  Loop-guard policy is the live `AppSettings.sessionPeerPromptMaxHops` setting
  (default 50, bounded to 1–200); every send reads it so Settings changes apply
  without a restart. A human-origin prompt closes the session's chains via the
  `liveSession` `setHumanPromptHook` seam. The engine talks to the hub through
  one `getHub()`/`setHubForTests` seam (not scattered `await import("./hub.ts")`
  call sites), so tests substitute a deterministic fake hub rather than
  module-mocking a process-wide singleton.
- `slackAssistantChat.ts` adapts authorized private `message.im` events into the
  permanent Assistant queue and adapts delivery events back into one updated
  private Slack placeholder; it must reject bot echoes/subtypes/other users,
  convert common Markdown to Slack `mrkdwn`, retry transient final updates, and
  never lose a request when placeholder delivery fails.
- `slackShortcutIntake.ts` owns the private `personal_assistant_create_task`
  message shortcut: defense-in-depth identity validation, persist-before-enrich
  Task creation, bounded/timed personal-OAuth context enrichment, bounded
  untrusted text/files/Task context, Task Intake Agent curation, and Slack
  source-link de-duplication/retry. Immediately after persistence it opens the
  user's private Pandeck App DM, posts a styled accepted/progress message, and
  updates that message with success or retryable failure; final messages link
  both the PA Task route and original Slack message. A duplicate shortcut posts
  a fresh linked “Task already exists” App-DM message instead of silently
  returning. Interaction/ephemeral delivery is fallback only. It must never post
  public reactions/messages or log message bodies/response URLs.
- Task intake settings may name one active project-registry id;
  `slackShortcutIntake.ts` resolves it before creation and links every new
  imported Task to that project, while missing/archived configured projects
  degrade to an unlinked Task instead of breaking persist-first intake.
- `taskIntakeAgent.ts` owns the provider-configurable one-shot curator for
  persisted Slack intake context. It may perform bounded research through an
  explicit read-only allowlist of enabled Pandeck tools; native file/shell tools
  and all mutation tools remain unavailable. Its output parser accepts only the
  strict `{ title, description }` JSON schema, requires an `## Action` opening,
  and rejects duplicated source metadata; failure leaves the already-persisted
  Task retryable.
- `webPush.ts` owns notification DELIVERY, and both routes of it.
  `sendWebPushNotification` reaches installations that subscribed and is the
  only path that survives the app not running; `deliverAppNotification` is what
  every caller uses, because it also broadcasts the same payload as an
  `appNotification` over the hub. That second route exists for clients whose
  runtime has no push service at all — the native shell is a WKWebView, where a
  subscription can never be created — and it is a broadcast rather than a
  targeted send because the server cannot tell the runtimes apart; the client
  decides whether it is the one that must act. `notifySessionTurnCompleted` is
  driven by a real normalized run completion, never a generic idle transition,
  and applies `sessionOutcomePolicy.ts` so the notification and Sessions inbox
  agree about child, intermediate parent, final parent, human and failed turns.
  `webPushStore.ts` holds the VAPID keys and subscriptions.

## Contract notes and rationale

- Validate all client messages and untrusted IDs before side effects.
- Preserve the split between harness (`pi`/`claude-sdk`) and persona
  (`assistant`/`workshop`/`developer`). Gate code-editing behavior with
  `isCodingAgentType` (shared) rather than comparing to `"workshop"`, so
  `developer` is never accidentally excluded; `workshop` remains dev-only
  (`devOnly`).
- `developer` sessions REQUIRE a worktree (the `main:<projectId>` checkout
  counts): without an `in_worktree` edge, `worktrees/sessionCwd.ts` falls back
  to the app CWD (the server's home directory in production). Every client
  creation path in `connection.ts` (`handleFirstSend` for both harnesses,
  `onNewSession`, `onCreateDraftSession`) rejects a bare developer session via
  `guardDeveloperWorktree`; `workshop` is exempt (the app CWD is its purpose).
  Guarded by `developerWorktreeGuard.test.ts`.
- The resume half of the same hazard ([Task-321](pa://task/321)): a session
  whose worktree was REMOVED under it keeps its `in_worktree` edge, so every
  later run would execute in the app CWD — a different repository than its own
  transcript ran against. The invariant itself lives at the shared run boundary
  (`session/runtimePrompt.ts`, which throws), NOT here: peer delivery,
  `session_send_prompt`, day scans, the post-reload continuation and the review
  handoffs all reach a session without passing through a `connection.ts`
  handler. `guardMissingWorktree` is the interactive half — `prompt`,
  `runSlashCommand` and the existing-session Knowledge handoff check it UP
  FRONT, so the user gets a clear error before any side effect rather than a
  failed turn. `runSlashCommand` exempts the commands in
  `CONTEXT_ONLY_SLASH_COMMANDS` (`/clear` today): they resolve no cwd, so the
  app-CWD fallback the guard exists to prevent cannot happen, and refusing them
  would leave a session whose checkout vanished unable to shed its context.
  Everything else is guarded by DEFAULT, which is why the set lists the exempt
  commands — `/compact` is on the guarded side because it spawns a provider
  query in the session's cwd. `acknowledgeMissingWorktree` records the answer
  per worktree id and clears `SessionListItem.worktreeMissing` /
  `SessionState.worktreeMissing`. LOADING such a session stays allowed on
  purpose: the banner offering the acknowledgement lives in the session view,
  and reading a transcript starts no turn. Covered by the resume and
  run-boundary tests in `developerWorktreeGuard.test.ts`.
- `provisionFirstSendWorktree` ([Task-240](pa://task/240)) is the "+ New
  worktree" arm of both first-send handlers, sitting beside
  `resolveWorktreeContext` and returning the same shape: it names the branch,
  runs `createWorktree`, and reports each phase to the sender. It runs BEFORE
  the session is acquired because a session's cwd is fixed at construction —
  `ClaudeSdkSession.cwd` is readonly and pi bakes it into the session header —
  so a session created first could never adopt the checkout. Everything after it
  is unchanged (developer guard, cwd, frozen prompt evidence, edges), and a
  failure returns `undefined`, which ends the send with no session and no turn.
  The completed provision is then recorded as the session's genesis card through
  `recordWorktreeProvisionForHost`, the same `SyntheticToolHost` seam the slash
  commands use, before the first prompt is driven. Covered by
  `firstSendWorktreeProvision.test.ts`.
- ALL app tools are the harness-neutral `AgentTool`s composed by
  `tools/catalog.ts`. Claude consumes them by mounting the generic per-session
  MCP server (`mcp/sessionToolServer.ts`) in-process; pi adapts them directly
  (`piSdk/agentToolAdapter.ts`) with deferred activation
  (`piSdk/toolActivation.ts`). Never hand a harness a third tool path or a
  harness-specific tool implementation.
- Keep DATA_DIR paths derived through config/session storage helpers rather than
  scattered string paths.
- Runtime-backed connections must keep the viewed working indicator sourced from
  runtime snapshots/events, not engine `state` or session-list broadcasts.
- Domain LIST broadcasts are addressed by topic, not fanned out.
  `hub.broadcastTopic(topic, msg)` sends only to connections whose
  `Viewer.wantsTopic(topic)` is true (`BroadcastTopic` in `@assistant/shared`:
  `tasks`, `projects`, `worktrees`, `knowledge`, `calendar`, `skills`), and
  every domain broadcaster seam
  (`taskEvents`/`knowledgeBaseEvents`/`worktreeEvents`/`dayScan/scanProgress`/`skills/skillLibraryEvents`)
  exposes exactly one `broadcast` the hub binds to its topic; migrated Projects
  instead expose notify-with-touched-ids from `projectRegistry.ts`, which the
  hub projects into that same topic. A `broadcastAll` seam would let a domain
  quietly opt out of addressing. `connection.ts` owns the `topics` set behind
  `subscribe`/`unsubscribe`, and subscribing is ALSO the authoritative read for
  every stateful list: cold `tasks`/`projects` and the complete app-level
  `worktrees` list answer with their current snapshot; warm migrated domains
  answer with a digest; `skills` answers with a fresh working-tree SCAN, which
  the topic seam publishes to every subscriber rather than to the asking
  connection alone. That last snapshot is essential after a connection was
  unsubscribed while an agent/tool changed a checkout; retaining an old browser
  array and waiting for the NEXT mutation would leave the UI stale. A connection
  that never subscribes receives none of the ongoing traffic. Purely
  event-shaped `knowledge` invalidations and `calendar` scan progress have no
  subscribe snapshot; their mounted surfaces issue authoritative HTTP reads.
  Memory invalidations stay `broadcastAll`: they are a handful of ids, and their
  consumers are ad-hoc panels rather than a list surface.
- `buildInfo.ts` resolves which build this process IS — declared version plus
  the commit it came from — and is also imported by `app/web/vite.config.ts` to
  bake the same answer into the browser bundle, so Settings → About compares two
  numbers produced by one resolver. The environment is trusted before git
  (`ASSISTANT_BUILD_COMMIT`, passed by `flake.nix` from `self.rev`), because a
  packaged build has no `.git` to ask; git is the development path and answers
  the tag question too. Synchronous and outside `gitExec.ts` on purpose: it is
  one question about the tree this process was built from, asked at most once
  per process (never in a packaged build) — and Vite's `define` needs it
  synchronously. `Connection.init` reports it as `ready.serverBuild`.
  `docs/ci-cd.md` holds the contract.
- `webBuild.ts` hashes the built `web/dist/index.html` shell (which names Vite's
  content-addressed entry chunk) into a stable web-build id. The id changes with
  a web deployment but not a server-only restart; `Connection.init` sends it as
  the FIRST production frame (`webBuild`, repeated on `ready.webBuildId`) so an
  already-open browser can reload before old JS consumes any newer
  snapshot/event shape.
- Task mutations notify `hub` WITH THE IDS THEY TOUCHED, and `tasks.ts` stamps
  those rows' `revision` from the persisted `task_revision` sequence in the same
  act — bump and notification cannot diverge (`docs/state-sync.md`). "Touched"
  includes every row an EDGE SWEEP moved, which is the easy half to miss:
  `deleteTask` reports the children whose parent edge it drops (they must be
  read before `taskStore.remove`), and `projectRegistry.deleteProject` reports
  the Tasks whose `in_project` edge `projectStore.remove` sweeps. Nothing else
  repairs those rows any more — the full-list broadcast that used to hide such
  holes is gone. The hub COALESCES the notifications
  (`TASK_BROADCAST_DEBOUNCE_MS`, the session list's shape) and
  `flushTaskBroadcast` diffs `taskRevisionIndex()` against the map it last
  flushed: changed or new live ids become `upsert` events carrying
  `taskSummaryFor(id)`, ids that left the live projection become `delete`s
  (archiving is a delete, unarchiving an upsert). The batch travels as one
  `stateEvents` message with a per-topic `seq`; a mutation NEVER puts a list on
  the wire. The first flush of a process seeds its baseline from the current
  live projection minus the pending ids (`seedTaskBaseline`), because every
  subscriber's snapshot was read from that same database. The same flush
  refreshes SESSION state only for sessions that are — or just stopped being —
  task-linked (from `taskLinkedSessionIds()`, keeping the previous set so a
  removed link still gets a final refresh); it used to re-run `toolExposure()`
  and `peerPromptThreadsFor()` for every open conversation on every Task edit.
  Tests that assert on the broadcast must wait out the debounce window.
  Subscribing to `tasks` delivers the full list ONCE, as the authoritative read,
  carrying the current `seq` as the client's gap baseline, so a browser/PWA
  cache cannot diverge across fresh loads (the subscribe is re-sent on every
  connect). That list is SUMMARIES ONLY, enforced by the wire types
  (`TaskListResponse.items` is `TaskSummary[]`; there is no
  `includeDescriptions` request flag any more). `taskSummaryOf` (shared, because
  the browser projects too when it settles an optimistic create) is the ONE
  explicit allowlist narrowing from `TaskItem` to `TaskSummary`: it drops the
  Markdown body, empty/default collection fields, unused commit time, and all
  session-ref metadata except `sessionId`/`origin` (including the server-local
  transcript path). The open Task's body and full refs are fetched per Task
  through request-correlated `getTask` → `taskDetail`; not-found and read error
  are distinct direct outcomes. `taskSaved` carries the full mutated `TaskItem`
  and nothing collective — it is the mutator's direct reply, so a save returns a
  fresh body without another round trip, and its echoed `requestId` is what
  settles the browser's optimistic create. The projection census test fixes the
  key allowlist and a representative per-item byte budget. On the 2026-08-13
  read-only production copy, this cut the 180-row snapshot from 184,419 to
  140,779 bytes. Done Tasks age out of this default list after 14 days;
  `tasks.ts` sweeps at boot/hourly and on writes through `archiveTask`, while a
  done child stays visible until its direct parent is done or archived (16 rows
  / another 13,429 bytes on that copy). All three triggers isolate/log sweep
  failures and retry later; a post-write retention failure cannot escape after
  the originating mutation is durable or suppress that mutation's
  version/listener notification.
- Per-OBJECT streams are addressed by the object a connection has open, never by
  topic. `worktreeEvents.ts`'s `broadcastWorktree(worktreeId, msg)` (gated by
  `Viewer.wantsWorktree`, i.e. the connection's `watchWorktree` set,
  canonicalized) carries
  `worktreeStatus`/`worktreeChanges`/`worktreeMergeUpdate`/`worktreeComments`:
  the working-tree tier pushes a full changed-file list after debounced dirty
  events and once when the tree becomes clean, suppressing repeat-empty pushes;
  it used to reach every connected browser because SOMEONE had a worktree open.
  Only `worktreeList` and `knowledgeChanged` stay topic-wide — both are
  list-level and small.
- Task activity traces are delivered per holder, not broadcast:
  `Viewer.wantsTaskComments(taskId)` gates `taskEvents.ts`'s
  `broadcastTaskComments`, and `connection.ts` subscribes a connection when it
  lists or adds that Task's comments (bounded by `MAX_OPEN_TASK_COMMENT_TRACES`,
  oldest evicted — a dropped Task simply refetches on reopen). The largest
  production trace is ~18 KB and used to reach every connected browser on every
  append. A `Viewer` that does not implement the predicate receives nothing,
  which is correct: it never asked for a trace.
- Prefer adding focused modules over expanding already-large switchboards unless
  central coordination is the change.

## Working notes

- When adding a tool, see `tools/CLAUDE.md`; when changing tool exposure or the
  browser tool groups, see `mcp/CLAUDE.md`.
- When adding a setting, include defaults, validation/test helpers, protocol
  shape, and Settings page UI as needed.
- Integration tool families are assembled dynamically in `tools/catalog.ts`
  (helpers re-exported via `agents.ts`): live session MCP servers register the
  complete optional universe, apply current integration gates to their active
  set, and receive `tools/list_changed` through `integrationToolChanges.ts`;
  one-shot helpers receive only the currently enabled subset. Tool-level
  credential checks remain defense in depth.
- Keep local `.test.ts` files type-safe and runnable through the server Vitest
  suite (`pnpm --filter @assistant/server test`).
- `architecture.test.ts` guards two boundaries: (1) runtime prompt paths — no
  direct `live.prompt`/`sdk.prompt` bypasses, adapter construction/factory use,
  or direct runtime prompt calls outside the sanctioned runtime/adapter layers;
  (2) SDK imports — `@earendil-works/*` only under `piSdk/`, and `mcp/`/`tools/`
  import neither agent SDK.
- Use `src/test/setup.ts` for shared Vitest process/env cleanup; keep individual
  tests isolated from real `assistant-data/` with temp data dirs when they touch
  persistence.

## Verification commands

- Run `pnpm --filter @assistant/server test` to run the tests.
- Run `pnpm --filter @assistant/server test:kb` for the focused KB regression
  and token/performance audit.
- Run `pnpm --filter @assistant/server typecheck` for changes in this subtree.
- Run root `pnpm run typecheck` if shared/web contracts change.
- Run root `pnpm run build` before closeout.
