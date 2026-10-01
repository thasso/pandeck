# Server persistence — implementation reference

Relocated from `app/server/src/db/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

SQLite-backed server metadata storage, migrations, and the session metadata
facade.

## Module ownership

- `index.ts` owns database connection lifecycle and migration execution.
- `sessionStore.ts` owns the single SQL-facing facade for session metadata,
  links, and usage totals. `session_index.scope` (migration
  `0047_session_scope.sql`, [Task-492](pa://task/492)) replaced the two-valued
  `visibility` column with the three-way `SessionScope`; the migration carries
  existing values over verbatim and reclassifies nothing. The column has NO
  DEFAULT and a CHECK over the known scopes, so a session row cannot exist
  without a scope somebody chose and an unknown one cannot be written; reads
  normalize through `sessionScopeOrFailClosed`, which resolves anything else to
  `internal`. Scope filtering is DEFAULT-CLOSED: `list()`/`countArchived()`
  without a `scopes` option read `user` rows only, `scopes: "all"` is the
  explicit opt-out for the few reads that are about session ids as such (id
  reconciliation, credential bookkeeping — the account-usage projection and the
  deletion guard read the SAME set, so Settings cannot report 0 bound sessions
  for an account deletion then refuses to release). Scope is INSERT-ONLY like
  `created_at_ms` and the credential profile: the first write owns the row, so
  neither an omitted nor a contradicting `scope` on a later `upsert`
  reclassifies a session, and the access policy built on it cannot be moved by a
  metadata refresh. `liveDefaultScopeGate(candidateIds)` is the read the LIVE
  list sources gate on (`sessions.ts`, `hub.ts`): they know nothing about scope,
  so a running `internal`/`subagent` session would otherwise ride into the
  sidebar past the store's own `WHERE scope = 'user'`. It is bounded by the
  caller's live ids and keyed by the primary key — the list rebuilds up to ~4
  times a second and every internal usage stub ever recorded is not worth
  scanning — and it FAILS CLOSED: an unreadable row, and a failed read, exclude
  the candidate. `claimScope()` is the write-side half that makes "a live
  session with no row is the user's" true: every live registration
  (`piStore.track`, `claudeSdkStore.acquire`) claims the id BEFORE the session
  enters the registry, writing the row for a non-default scope and THROWING when
  the claim contradicts the stored one, so a spawn path that fails to declare a
  subagent session fails at the registration instead of leaking it into the
  sidebar. `session_index.credential_profile_id` (migration
  `0027_session_credential_profile.sql`) binds a first-prompt-selected PA
  credential profile immutably to the session; it is a profile id, never a
  credential path or secret. `session_index.mode` (migration
  `0041_session_mode.sql`) stores the mutable Build/Plan policy and defaults
  legacy rows to Build. `background_work_items.description`, `command` and
  `command_truncated` (migration `0059_background_work_command.sql`) hold what a
  background job runs, bounded at 4 KB with the cut recorded; a tombstone clears
  them with the label. `settled_at_ms` and `last_error_at_ms`/`last_error_text`
  (migration `0028_session_settlement.sql`) back the Sessions inbox: settlement
  is INDEPENDENT of `archived_at_ms` (a settled session stays in the ordinary
  list), and the failure text is bounded inside `recordRunFailure` so no caller
  can persist a stack trace into a sidebar label. The four `attention_*` columns
  (migration `0057_session_attention.sql`, [Task-674](pa://task/674)) make
  settlement event-based: `recordSessionOutcome` bumps `attention_revision` with
  the outcome's kind and time, `setSettled(true)` writes
  `attention_settled_revision = MAX(attention_settled_revision, MIN(attention_revision, throughRevision))`
  — the `MIN` keeps a stale acknowledgement from reaching past what it saw, the
  `MAX` keeps two tabs settling out of order from un-acknowledging an outcome
  the user already put down — and `isSettled` is the conjunction ("put down, and
  nothing raised since"). Existing databases start at 0 acknowledged through 0,
  which is exactly what keeps an already-settled row settled across the
  deployment. Like read/archive/tombstone state, all of them are owned by their
  own methods and excluded from `upsert`'s column list, so a metadata refresh
  never disturbs them. `setArchived(true)`/`setSettled(true)` also read the
  session through to its last activity (`markReadThrough`), because putting work
  down and having an unread response are contradictory states; `touch(id, ts)`
  moves `updated_at_ms` FORWARD ONLY, and is what a run start uses to re-sort
  the inbox at prompt time. `session_prompt_conditions` (migration
  `0034_session_prompt_conditions.sql`,
  `freezePromptConditions`/`getPromptConditions`) holds the session-START
  conditional prompt assembly ([Task-287](pa://task/287)) as opaque JSON owned
  by `../promptConditions.ts`. It is INSERT-ONLY — the first write wins for the
  session's life, because a later value would move the assembled system prompt
  and bust the provider's cache prefix — and it is its own table rather than a
  `session_index` column because pi builds the prompt inside session creation,
  before the metadata row exists. A failed write degrades to the caller's own
  recomputed record rather than blocking the session. `session_skills`
  (migration `0053_session_skills.sql`, `freezeSkills`/`getSkills`) uses the
  same pre-metadata, insert-only shape for the sorted library-skill names frozen
  by `../sessionSkills.ts`; the store treats its JSON as opaque and the
  lifecycle seam validates it. `session_worktree_ack` (migration
  `0035_session_worktree_missing_ack.sql`,
  `acknowledgeMissingWorktree`/`worktreeMissingAck`/`worktreeMissingAckBySession`)
  records that the user accepted running a session in the app CWD after the
  worktree it ran in disappeared ([Task-321](pa://task/321)). It stores the
  acknowledged WORKTREE id, not a flag, so an answer never carries over to a
  worktree the session is linked to later; the store makes no judgement about
  relevance (`../worktrees/sessionCwd.ts` compares it against the live edge).
  Its own table for the same reason as prompt conditions: a session id can carry
  edges and a transcript without a metadata row. `getUsageTotals(id)` is the
  read side of `session_usage_totals`, added so the session audit
  ([Task-254](pa://task/254)) can reconcile its own per-turn sums against the
  persisted numbers field by field instead of re-deriving them.
- `sessionSnapshotRead.ts` owns READ-ONLY session reads against ANY data
  directory, for the measurement CLIs (`pnpm run measure:session`) that audit a
  data dir this process did not configure. It exists so those tools write no SQL
  of their own: it opens its own `readOnly` handle — deliberately NOT `getDb()`,
  which would migrate the user's live database from a checkout — closes it
  before returning, and returns plain values (metadata, usage totals, the frozen
  prompt-condition JSON, the attached Task id) with the tombstone flag and the
  row's `scope` reported for the caller to refuse on.
- `subagentStore.ts` owns the durable PA-subagent thread/run substrate
  ([Task-493](pa://task/493), migration `0048_subagent_threads_runs.sql`). A
  thread uniquely owns one `scope = 'subagent'` session beneath an ordinary user
  session or persisted workflow-step executor (never another subagent) and
  freezes the fully resolved role/slot/account/model/thinking/result-contract
  profile in the same `BEGIN IMMEDIATE` transaction as its first run; incomplete
  profiles never produce a row. Initial and continuation acceptance receive the
  effective positive safe-integer parent limit from the caller, count accepted
  nonterminal runs under that transaction, and import no policy default. Runs
  have monotonic per-thread rounds, immutable terminal history, explicit
  status/execution-phase/watchdog machines, and a partial unique index that
  permits a successor only after the prior run is terminal and quiescent. Result
  acceptance and Stop are competing irreversible CAS decisions: result-first can
  end only `submitted`, Stop-first only `stopped`; persisted quiescence evidence
  is required before either terminal write and is cleared whenever execution
  resumes so only the newest completion can satisfy the gate. Required parent
  responses retain exact message correlation and resume the same run, while
  watchdog/nudge state advances `unused → reserved → admitted → completed` and
  ordinary execution reconciliation cannot reset it. One authoritative usage
  completion snapshot replaces (never callback-increments) the thread cumulative
  mirror and run delta. Every mutation runs through `mutation` and
  `markSubagentStateChanged`: one persisted `subagent_revision` value stamps
  deduplicated run ids plus their containing threads inside the write
  transaction, then one touched-id notification occurs after commit. Registry
  membership and `deleted_at_ms` remain on scrubbed Task-490 parent-tree
  tombstones, preserving id/session/ref and revision guards without retaining
  user content or allowing resurrection. Parent lifecycle cascades call
  `sessionStore` for root/child archive, settlement, and read-through semantics
  while updating inherited thread flags in that same transaction;
  restore/unsettle never rolls read time back. Reads include the unique
  session-to-thread authorization/profile-resolution lookup and bounded
  thread/run pagination; no projection or broadcast read occurs in SQL
  transactions. Task-495's usage write accepts only the authoritative durable
  session cumulative and derives the run delta from its frozen opening baseline;
  a duplicate completion identity is a no-op, while parent usage is computed on
  read from parent-own totals plus each thread cumulative exactly once.
  `delegationSummaries()` is the single grouped read behind session-list
  starting/working/awaiting-parent counts, and `delegationObligations(parent)`
  projects active runs, accepted results not yet admitted to the parent
  transcript, and still-owned `managed` worktrees. Those worktrees remain an
  obligation until their linkage is explicitly removed as integrated/discarded;
  terminal runs and usage/result envelopes otherwise remain retention-pinned
  until the Task-490 parent-tree deletion seam.
- `backgroundWorkStore.ts` owns the durable provider-neutral background-work
  substrate ([Task-482](pa://task/482), migration `0054_background_work.sql`).
  One `background_work_items` row represents a Claude vendor task, a
  PA-supervised pi command, or a command/WebSocket monitor through the same
  lifecycle — `pending-launch`/`running` nonterminal,
  `completed`/`failed`/`not-started`/`stopped`/`lost` terminal — and stores no
  vendor task id as an address, no OS process id or group, no command line,
  path, environment, credential or output body. Evidence is validated against
  its MERGED result (captured never exceeds original, truncation reports both
  sizes, a pinned artifact id is compared normalized and never repointed), so
  the store and the schema refuse the same states and an incoherent capture is a
  named error rather than a raw constraint failure. Stop is REQUEST metadata
  (`none`/`requested`/`awaiting-binding`/`unconfirmed`) on a still-nonterminal
  row, so an unanswered Stop never fabricates a terminal state; a Stop that wins
  the pre-execution race terminalizes as `not-started` with `stopped-by-owner`,
  and a host close writes the distinct `stopped-by-host-close`.
  `background_hosts` is the OPTIONAL Claude retained query epoch, created lazily
  on the first admitted or observed background item (an ordinary transient query
  writes no row), unique per `epoch_key` and limited to one live epoch per owner
  session. Owner-slot capacity is DERIVED rather than a second bookkeeping
  table: a session holds a slot exactly while it has admitted nonterminal work
  or a live epoch, the caller supplies the effective limit (no policy default is
  imported here), and `claimOwnerSlot` decides the last free slot inside the
  same `BEGIN IMMEDIATE` transaction as the insert, and reuse by the same
  owner's later children is free. `observed-adopted` and `observed-over-cap` are
  the degraded provenances for work already executing without a reservation; the
  over-cap row is durable and counted in occupancy but is never a held slot, so
  one unreserved observation cannot license more admissions.
  `(owner_session_id, source_request_id)` makes admission idempotent — and
  `getItemBySource` is the READ half of that, so an admission path can recognise
  its own retry before it re-applies mutable policy instead of judging an
  existing row against settings that never governed it; it answers whatever
  state the row reached, because a retry may not resurrect work that ended —
  `(host_id, provider_task_id)` makes a binding unique within its epoch only,
  and `last_event_id`/`last_event_seq` guard repeated and reordered provider
  evidence — `sequence` is the ordering guard (monotonic per item, covering
  duplicates and reordering), while `eventId` alone recognises only the
  immediately preceding event, so a backend whose events can arrive
  non-adjacently out of order must supply a sequence. Claude work always belongs
  to an epoch (a hostless `claude-query` row could never bind or be stopped, and
  the schema refuses one), an epoch inherits its admission's provenance and
  GOVERNS its children's, so an over-cap epoch cannot launder later work into an
  ordinary slot: a reserved admission aimed at one is refused with
  `BackgroundWorkOverCapEpochError` (which reports the caller's real limit and
  says the EPOCH, not the current cap, refused it), and a further observation
  inside it stays over-cap rather than adopting a free slot — which is what
  keeps "held" from flapping with whichever child happens to be active. An epoch
  is `creating` only as a pre-execution reservation: observed work is already
  executing, so its epoch is `live` on arrival, and `markRunning` promotes a
  reserved epoch the moment its first child starts rather than waiting for the
  backend to report the query. Releasing a reservation is therefore an EXPLICIT
  path, never inferred from a terminal state — `failLaunch` (the provider
  reported no task, or the spawn failed) and a pre-launch owner Stop close an
  otherwise-unused `creating` epoch as `reservation-released` in their own
  transaction, while an ordinary `terminalize` is the runtime outcome of work
  that did run and releases nothing. `failLaunch` refuses a row that already
  executed, and the release helper independently refuses any row carrying a
  `started_at_ms`. A `live`/`draining` epoch is left alone, since a real query
  exists and its quiet grace and closure belong to the backend; that epoch keeps
  reporting `retainedHost` activity after its last child ends and blocks settle,
  delete and history tombstoning until it closes. Host terminalization fans out
  the outcome each child actually had: a lost epoch loses its children, a child
  that never launched ends `not-started`, and a planned drain's reason survives
  the generic host-close one. Every write runs through `mutation`, which stamps
  one persisted `background_work_revision` across the touched items — a touched
  host pulls in its items, whose projection carries its state — and notifies
  once after commit; the projector runs after the stamp, so a returned row
  already carries the revision that write minted. `reconcileBoot` is the
  restart-honest seam: nonterminal rows and live epochs from another
  `boot_epoch` become `lost` with `server-restart`, a planned drain's recorded
  reason wins over that default, a second pass is a no-op, and nothing is ever
  replayed. `activityByOwner()` is the single grouped read behind
  `SessionListItem.backgroundActivity`. `deleteOwnerSession` is the session
  delete itself: one transaction marks the session deleted and scrubs its
  history, refusing to hide work that is still active, and
  `tombstoneDeletedOwners` is the boot repair for owners deleted without it.
- `taskStore.ts` owns task rows plus their typed edge helpers.
  `tasks.scheduled_for` (migration `0029_task_scheduled_for.sql`) is the day
  work is PLANNED for, deliberately a second date beside `due_date` rather than
  a reuse of it: a deadline is imposed from outside and a plan is a choice, and
  the Backlog's Focus view buckets on whichever falls first so neither can hide
  the other. It is a DATE, not a today/tomorrow flag, so a plan for a day that
  has passed reads as unfinished instead of silently still claiming to be
  today's work; `../tasks.ts` normalizes both through one `normalizeDateOnly`
  and exposes the `scheduled` list filter
  (past/today/tomorrow/upcoming/unplanned) that `task_read` and "plan my day"
  use. `tasks.triaged_at_ms` (migration `0031_task_triage.sql`) is when the USER
  processed a Task that arrived on its own; null means it is still in the
  Backlog's Inbox. That migration BACKFILLS every existing row to its
  `created_at_ms` — without it the Inbox would open holding the entire history,
  hundreds of rows and none of them new, which is the opposite of what it is
  for. `tasks.source_agent_type`/`source_session_id` (migration
  `0032_task_source_provenance.sql`) persist WHICH agent produced a Task:
  `TaskSource.agentType`/`sessionId` were on the wire and in the tool schema all
  along, but nothing stored them, so `../tasks.ts` `toSummary` rebuilt `source`
  as `{ createdBy }` alone and every arrival read as a generic "from an agent"
  in the Inbox. The `tasks.status_suggestion_*` columns (migration
  `0033_task_status_suggestion.sql`, which RENAMES `0030`'s
  `done_proposed_at_ms`/`done_proposed_by` and adds `_to`/`_reason`) hold the
  one pending agent suggestion — `done` or `todo`, when, which session, and one
  short reason — because it generalized from an implicit `done` claim and a
  second nullable claim column would have let two contradictory ones coexist;
  every migrated row becomes a `done` suggestion. `taskStore` also owns durable
  Task status-change provenance (`task_status_events`, migration
  `0021_task_status_events.sql`: from/to status + actor kind/id per change,
  recorded by `../tasks.ts` `updateTask` from the caller-supplied `actor`); the
  day scanner's self-exclusion reads it via
  `statusEventsInWindow`/`statusEventsForTask`. `setParent`/`setProject` are
  also where the "a subtask lives in its parent's project" invariant is kept
  (`docs/tasks.md`): a move inherits the new parent's project for the node and
  its subtree, and an assignment cascades down it. They are the only seam all
  four write paths share — the Backlog drag reaches `setParent` through
  `../tasks.ts` `reorderTasks` without passing `applyRelations`. Both RETURN the
  other rows they moved (a project cascade is a write to a whole subtree), so
  the caller can report them through the change-notification seam.
  `nextSortOrder(parentId)` answers the other half of joining a group: the free
  manual position a Task takes when nobody stated one, so no row ever reaches
  the Backlog without a place of its own and the client never has to infer one
  from a field a status change moves. The two groups take opposite ends. A Task
  joining the ROOT is an arrival that has to be seen, so it goes strictly below
  the smallest `sort_order` in the table — a value no live row and no archived
  one still holding its old index can collide with, at the cost of drifting
  negative until the next drag renumbers the tree. A Task joining a PARENT is
  part of that parent's plan, and a plan reads top-down, so it is appended after
  its siblings (archived ones counted, for the same reason). `../tasks.ts` asks
  on create, on a reparent that states no position, and on unarchive.
  `tasks.revision` (migration `0040_task_revision.sql`) is the state-event
  revision: `stampRevisions(ids)` allocates ONE value from the persisted
  `task_revision` sequence per notification and stamps every touched row with
  it, including tombstoned ones (a delete event carries a revision too), and
  `revisions()` reads the whole `{id → revision, live}` index the broadcast
  flush diffs. The counter is persisted because a restart that handed out
  numbers a client has already seen would emit events every subscribed browser
  silently discards.
- `taskCommentStore.ts` owns the `task_comments` rows (migration
  `0020_task_comments.sql`): a flat, append-only, chronological activity trace
  per Task (`author_kind` user/agent/system, `author_name`, optional
  `author_session_id`, `body`, `created_at_ms`). No FK on `task_id` (tasks
  soft-delete, mirroring `worktree_comments`); rows are hard-removed only on
  permanent Task deletion (`../tasks.ts` `deleteTask` → `removeForTask`),
  archive keeps them. `countsByTask` is a single `GROUP BY` pass for list
  badges, `countForTask` the single-row count a Task's state event carries.
  Projection/broadcast live in `../taskComments.ts`.
- `permanentAssistantStore.ts` owns the singleton permanent-session binding and
  durable cross-channel FIFO queue; interrupted `working` items recover to
  `queued` at boot.
- `peerPromptStore.ts` owns transactional peer-prompt persistence
  (`peer_prompts` + `peer_prompt_chains`/`peer_prompt_chain_participants`).
  Every state change is a SQLite transaction with a compare-and-set guard; legal
  status transitions
  (queued→dispatching→admitted→acknowledged→completed/awaiting_response→replied,
  plus retryable_failed/interrupted/failed/expired) live in the store, not tool
  code, via the shared `transitionInTxn` primitive (also used by
  `claimNext`/`claimBatch` so every status change — including claims — appends
  to the row's bounded `transitions_json` audit trail, exposed as
  `PeerPromptRecord.transitions`). It owns FIFO `queue_seq` allocation, drainer
  lease claim/release/expiry, boot recovery of in-flight rows, and retention
  (`expireUnresolved`/`pruneTerminal`); terminal rows whose identity is still
  referenced by a live `subagent_runs` row are excluded from pruning until the
  Task-490 parent-tree deletion scrubs that run. `requeueExpiredLeases` (a hung
  in-process dispatch lease past `lease_expires_at_ms`, independent of
  `requeueDueRetries`'s `retryable_failed` path) and `expireUnresolved` drive
  their per-row status changes through `transitionInTxn` (not a raw multi-row
  SQL `UPDATE`) inside one transaction, so every requeued/expired row gets an
  audited `transitions` entry and `expireUnresolved` returns the affected
  `PeerPromptRecord[]` (not a bare count) so callers can broadcast per row.
  `unfinishedTurnCount(sender, recipient)` is the narrow read behind the
  directly spawned peers' concurrency cap ([Task-595](pa://task/595)): how many
  of one sender's messages to that recipient are still `queued`, `dispatching`,
  `admitted` or `acknowledged` — that is, a turn accepted but not finished. It
  deliberately excludes `completed`/`awaiting_response` (post-turn) and
  `retryable_failed` (not running; its retry re-enters as `queued`), which is
  what lets a caller treat it as a self-clearing signal instead of a timer.
  `listDispatching()` is a read-only listing of every `dispatching` row; the
  ONLY function that actually moves them is
  `applyRecoveryDecisions(decisions, failureReason)`, which commits an entire
  caller-supplied boot-recovery plan (each row's decided `queued`/`interrupted`
  target, plus an optional `batch_head_id` restoration) in ONE transaction —
  every row goes DIRECTLY `dispatching` → its final status, so the decision
  (against the recipient canonical log, which the store itself never reads) and
  the write can never be split across two separate commits.
  `recoverStrandedAdmitted` closes the OTHER crash window Task 88 requires
  (admitted, but the process died before run completion): every row still
  `admitted`/`acknowledged` at boot unconditionally becomes `interrupted` (never
  re-queued — re-queuing an already-admitted row would re-inject a second
  visible prompt) via the same audited `transitionInTxn` path.
  `markDeliveryBatch(ids, headId)` durably records a plain (non-transition, no
  audit entry) fact — the head row id every member of one delivered batch was
  admitted together as (`batch_head_id`) — so a later reconnect/history read can
  reconstruct the SAME recipient-side batch grouping the live delivery used, not
  just derive it transiently at delivery time.
  `listByBatchHead(recipientId, headId)` returns a batch's COMPLETE membership
  (matching `batch_head_id` OR `id`, so it still finds the head row even if a
  narrow crash window left its own `batch_head_id` unset) regardless of any
  bounded/paginated caller window, so every aggregate-state computation (live
  broadcast or history read) is always based on the full batch, never a partial
  one. `enqueueRouted` performs the closed-chain re-check + hop reservation +
  loop-limit check + participant accumulation + message insert + (if
  `markRepliedId` is set) marking an earlier request replied, ALL in one
  transaction: an over-limit send rolls back without consuming a hop or
  persisting (`PeerPromptHopLimitError`), and a chain found closed at
  transaction time atomically reroutes to the caller-supplied `fallbackChainId`
  instead — closing the human-reset race where the chain could close between a
  read-only routing decision and the enqueue. `bumpChainNextHopTo` restores
  imported chain counters. `markRetryable(id, reason, backoffMs)` schedules
  `next_attempt_at_ms`; `requeueDueRetries` is the ONLY path back from
  `retryable_failed` to `queued` (without it those rows are a permanent dead
  end) and is driven by a periodic sweep, not just boot recovery. Failure
  transitions (`markRetryable`/`markInterrupted`) accept
  `admitted`/`acknowledged` so a post-admission crash/busy-race never strands a
  row. `failure_reason` deliberately survives `requeueDueRetries`/re-claim (a
  queued/retrying row's history stays visible) but `markAdmitted` explicitly
  clears it (`failureReason: null`) the moment admission succeeds — the one
  column any `transitionInTxn` patch omits by default is left unchanged, so
  every OTHER transition must pass it explicitly whenever a prior transient
  failure should stop being shown.
- `projectStore.ts` owns the projects row + `project_paths` child table and the
  project graph edges (`parent`, `jira`, and the standalone
  `session —in_project→ project` mapping). It is pure persistence;
  normalization, validation, and the lookup/scoring engine live in
  `../projectRegistry.ts`.
- `worktreeStore.ts` owns worktree rows, `in_worktree` edge helpers, and
  worktree review-comment rows; lifecycle rules live in `../worktrees/`.
  `worktree_comments.worktree_id` has no FK (dropped in `0007`) so comments can
  key to a project's synthetic `main:<projectId>` worktree, which has no row.
  Spawned-comment lifetime is therefore explicit: `finalizeWorktreeRemoval`
  atomically tombstones the row and removes roots (the self-FK cascades replies)
  after proving every target row is target-rooted and no descendant crosses
  scope; `insertComment` checks active state in its own write transaction.
  `branch_cleanup_oid` is the single pending-cleanup claim and branch identity;
  NULL means an ordinary tombstone cannot retry. `listOrphanedWorktreeComments`
  supplies the dry run, while destructive classification and deletion are one
  atomic sweep. The edges are insert-only, so `sessionIdsForWorktree` answers
  "every session ever linked" — a checkout keeps its finished review and fork
  sessions — and anything acting ON the checkout uses
  `liveSessionIdsForWorktree`, which drops the archived, deleted and EFFECTIVELY
  settled ones (`sessionStore.isSettled`, so a session woken by its own outcome
  still counts as working in the checkout).
- `links.ts` owns the generic edge graph and fixed relation vocabulary;
  `sessionObjectStore.ts` owns durable `session —context→ first-class object`
  edges (surfaced as inspector related-object rows) and projects them as compact
  `SessionObjectRef` rows; `sequences.ts` owns per-type integer id allocation.
- `memoryStore.ts`, `memoryObservationStore.ts`, `memoryLoadStore.ts`,
  `memoryProcessorStore.ts`, and `memoryOperationStore.ts` own the agent-memory
  persistence facades (migration `0011_memory.sql`, plus append-only follow-ups
  `0012_memory_load_columns.sql`, `0013_memory_operations.sql`,
  `0014_memory_load_provenance.sql`, `0015_memory_load_failed_state.sql`, and
  `0016_memory_cards_recurring_scan_idx.sql`): versioned memory cards (one row
  per stable id; `revision` is the optimistic-concurrency token bumped by
  `updateChecked`; superseded/archived rows and `supersedes_id` lineage stay
  auditable; scope is columnar `project_id`/`persona` for parse-free
  intersection matching; `idempotency_key` is uniquely indexed), the durable
  observation buffer (bounded human/assistant text + immutable
  `source_timestamp_ms`/`timezone`, atomic claim/release/stale-recovery), the
  per-session last-delivered snapshot + per-turn effective-load audit
  batches/items (idempotent per session+turn; `reused` records the effective set
  with zero injected chars; `cumulative_injected_chars` on batches and a
  per-item provenance snapshot —
  `source_kind`/`source_session_id`/`source_message_id` — on
  `memory_load_items`; `delivery_state` also accepts `failed`, an explicit
  selection/delivery-failure audit for an accepted turn), the global processor
  usage/cost ledger (reserve-before-call, reconcile-with-late-cost, rolling
  call/cost windows), and the operation-idempotency ledger (`memory_operations`:
  trusted operation key → the card id it produced, so an exact retry of any
  mutation path is a no-op; pruned on a rolling retention window).
  `memoryStore.list`/`count` share one WHERE-clause builder
  (states/kinds/projectId/persona/pinned/text via SQL
  `LIKE`/temporalModes/activeNowMs) so a caller's total always matches its
  paginated page exactly, at any dataset size — no candidate-universe scan cap.
  `list` also accepts a keyset `afterCursor` (`{ updatedAtMs, id }`, matching
  its `ORDER BY updated_at_ms DESC, id`) as an alternative to `offset` for
  chunked full-scan callers (e.g. the `activeNow` recurring scan in
  `../memory/memoryApi.ts`) — an increasing `offset` forces SQLite to re-walk
  and discard the whole already-seen prefix per call (O(N²) across a full scan);
  the cursor is O(1) relative to the prefix already consumed, and ONLY actually
  realizes that if an index covers the filter + order — `0016`'s
  `memory_cards_recurring_scan_idx (temporal_mode, updated_at_ms DESC, id ASC)`
  is that index for the recurring scan specifically (verified via
  `EXPLAIN QUERY PLAN` in `memoryStoreQueryPlan.test.ts`, which uses
  `debugListQueryForTests` to introspect `list`'s EXACT SQL so the test cannot
  drift from the real query). `0015` rebuilds `memory_load_batches` (widening
  its `delivery_state` CHECK) under `-- assistant:migration:foreign_keys_off`,
  explicitly reseeding `sqlite_sequence` after the rename/copy/drop so the
  AUTOINCREMENT identity cannot collide with a preserved historical id. These
  are pure persistence; validation, lifecycle, scope resolution, and idempotency
  policy live in `../memory/`.
- `daySynthesisStore.ts` owns the day-synthesis application journal (migration
  `0022_day_synthesis_journal.sql`): `day_synthesis_runs` (run-level
  `preflight`→`applying`→`applied` + the single run-id-tagged `kb_commit`) and
  `day_synthesis_candidate_tasks` (the UNIQUE candidate→Task mapping).
  `ensureCandidateTask` (INSERT OR IGNORE) makes Task creation idempotent so a
  crash between Task creation and the KB commit resumes rather than duplicating;
  `listUnterminatedRuns` feeds `../dayScan/synthesisApply.ts` startup
  reconciliation. Pure persistence; the apply protocol lives in `../dayScan/`.
- `tempoPlanStore.ts` owns the day Tempo-plan rows (migration
  `0023_day_tempo_proposals.sql`, widened by `0024_day_tempo_declined.sql`): a
  SERIALIZED proposal state machine where exactly one transition may win — every
  change is a status-guarded UPDATE (`WHERE id=? AND status IN (...)`), so a
  racing approve (`pending-approval → executing`) and cancel (`→ cancelled`)
  cannot both succeed, and cancellation is refused once `executing`.
  `declineProposal` (Task 144) is the user-facing deliberate terminal
  `→ declined`, distinct from a proactive `→ cancelled`; both win only
  pre-execution. The row id IS the Tempo `clientId`; durable linkage
  (proposal/result entry ids + returned worklog id) lives on the row. A re-run
  preserves `user-edited`/`dropped`/`declined`/in-flight rows by id.
  Projection/reconcile live in `../dayScan/tempoPlan.ts`.
- `workflowStore.ts` owns the three Workflow Run tables (migration
  `0036_workflow_runs.sql`, [Task-364](pa://task/364),
  `docs/agent-workflows.md`): `workflow_runs` (Task/Project links, recipe
  id+version, the worktree/branch the run owns, lifecycle + its reason, plain
  limit columns, and — `0037_workflow_run_config.sql`, [Task-366](pa://task/366)
  — an opaque recipe-owned `config_json` captured at creation with no update
  path, a recorded INPUT rather than the mutable run blob the schema forbids),
  append-only `workflow_steps` (kind, opaque payload, status, executor
  session/operation ref, structured result columns, attempt count,
  `predecessor_id`), and append-only `workflow_events` (transition + actor
  kind/id). The store is where append-only stops being a convention: there is no
  payload rewrite; a terminal step or run throws `WorkflowImmutableError` on any
  further write (so a revision appends a successor carrying `predecessorId`
  instead), and the only hard removal is `deleteCancelledRun`, which refuses
  every lifecycle but cancelled and atomically cascades that run's history. A
  result is written by the same transaction that makes its step terminal and
  never again, a run's worktree binds once, and EVERY mutation appends its
  `workflow_events` row with the caller's actor inside the same transaction — a
  transition without provenance is not expressible. The lifecycle gates are the
  store's too, not the engine's to remember: a PAUSED run admits and starts
  nothing (`WorkflowRunPausedError`, deliberately a distinct RECOVERABLE error)
  while a turn already running may still record attempts and its result — that
  is the difference between pausing and cancelling — and ending a run cancels
  its still-open steps in the same transaction, so no step is left waiting on a
  run that is over and no session stays holding a dead assignment. A pause
  without a reason is refused (`WorkflowValidationError`): the card states why
  every time. Two architecture invariants are enforced by the SCHEMA rather than
  by a check the next caller could skip — a partial unique index on
  `(executor_id) WHERE executor_kind='session' AND status IN ('pending','running')`
  makes "a session executes at most one active step assignment at a time" atomic
  across ALL runs (the store translates the lost race into
  `WorkflowExecutorBusyError`), and `UNIQUE (id, run_id)` plus the composite
  foreign keys `(predecessor_id, run_id)` and `(step_id, run_id)` →
  `(id, run_id)` keep both a causal chain and an event's step inside one run (a
  run-scoped event leaves `step_id` NULL, which satisfies the key). The step
  lifecycle is `pending → running → terminal` with no shortcuts, so an attempt
  or a result requires a step that actually started, and a supplied result must
  carry the SAME status the step ends with — a `completed` step holding a
  `failed` result is a history that contradicts itself. Result summaries and
  pause reasons are truncated to the shared bounds; an oversized structured
  payload is REFUSED (`WorkflowPayloadTooLargeError`) rather than silently cut,
  because large content belongs in its own domain store. Only the two
  vocabularies the architecture fixes (run lifecycle, step kind) are
  CHECK-constrained; status, executor and event-type vocabularies stay open at
  the SQL layer (like `session_index.agent_type`) and are owned by
  `@assistant/shared`'s `workflow.ts`. Ids come from `sequences`
  (`workflow_run`/`workflow_step`/ `workflow_event`), so a step's monotonic id
  IS its append order. The persisted step executor reference is also the durable
  Workflow run/step → executor-session ownership edge;
  `workflowOwnershipForExecutor` queries its retained history so a subagent's
  immediate parent stays that executor session while the engine remains
  lifecycle authority. Completing a session-executed step or the whole run asks
  the shared delegation-obligation predicate first, refusing while its child
  work/result/worktree obligations remain. Pure persistence: which step comes
  next is the recipe engine's decision, and row→wire projection lives in
  `../workflowRuns.ts`.
- `contactStore.ts` owns the `contacts` rows (migration `0026_contacts.sql`):
  the general people directory — `name`, `roles[]`,
  `email`/`jira_id`/`slack_id`, an extensible `ids` map, routing `areas[]`, and
  `notes`, with identity indexes on email/jira_id/slack_id for dedup lookup
  (`findByIdentity`). Pure row I/O; id derivation, normalization, merge policy,
  and lookup/projection live in `../contacts.ts`.
- `links.ts`'s `outgoingByType(fromType, relation)` is the BATCH read behind the
  session list: one indexed scan grouped by source id, for a caller that would
  otherwise issue the same query per row. Prefer it (and a typed index helper
  next to the per-row accessor, as
  `sessionProjectIndex`/`worktreeIdBySession`/`objectRefsBySession` do) whenever
  a list resolves a relation for every row.
- `migrations/` owns append-only SQL schema migrations.
- `migrations.lock.json` is the checked-in manifest of each migration's sha256
  (byte-for-byte the runtime checksum). `migrationsManifest.ts` owns the shared
  hashing/read/serialize helpers; `migrationsLock.test.ts` fails CI when a
  locked migration's content changed (an edit to an already-applied migration —
  the class of bug that crash-loops deployed databases at boot), when a
  migration file is not registered, or when a locked file was deleted;
  `updateMigrationsLock.ts` (run via
  `pnpm --filter @assistant/server migrations:lock`) is add-only and REFUSES to
  rewrite an existing entry, so an illegal edit cannot be laundered by
  regenerating the lock. None of those see a migration RENUMBERED during a
  rebase — after conflict resolution the lock and the files agree, and only the
  base branch remembers the old name — so `scripts/check-migrations-lock.mjs`
  (`pnpm run check:migrations`, and a CI step with the PR base) compares the
  lock against the merge base and rejects a renamed, rehashed, or removed entry
  plus two files claiming one version.
- `migrationOwner.ts` owns who may CHANGE a data directory's schema. It records
  whether the build that last applied a migration was packaged (a `/nix/store`
  path: a release or a PR preview) in `DATA_DIR/.migration-owner.json`, and
  `runMigrations` refuses to apply anything from a working copy to a directory a
  packaged build owns — the deliberate `DATA_DIR=…/assistant-data pnpm …` case,
  which opening the database alone is enough to trigger. Reads are unaffected
  (nothing pending is never refused), a later release is another packaged build,
  a working copy never downgrades a packaged owner, and
  `ASSISTANT_ALLOW_FOREIGN_MIGRATIONS=1` is the out-of-band repair escape hatch.
- `runMigrations` computes the whole pending set before applying any of it, so a
  refusal leaves the database untouched, and distinguishes a renumbered version
  (the recorded `name` differs from the shipped file) from an edited one in the
  error it throws. Contract and repair runbook: `docs/migrations.md`.

## Contract notes and rationale

- Keep session content out of SQLite; conversation bodies live in per-session
  log files or harness stores.
- Store durable locators as session IDs/provider IDs, not derived local file
  paths.
- Preserve `sessionStore.upsert` merge semantics: omitted optional fields must
  not clear existing metadata.
- Projects keep a stable TEXT slug id (referenced by task/session `in_project`
  edges and `knowledge/projects/<id>/` folders); do not switch them to integer
  sequences. `projectStore.put` replaces child tables and `parent`/`jira` edges
  wholesale, so callers pass the fully assembled record.
- Add new relations to the fixed vocabulary in `links.ts` rather than inventing
  per-call strings.
- Add new migrations rather than editing already-applied migration files unless
  the repository has not shipped them.
- Keep `session_index.agent_type` open-ended at the SQLite layer; known personas
  are owned by `@assistant/shared`/`agentTypes.ts`, so adding a persona should
  not require another table rebuild.
- Migrations that must rebuild a table referenced by foreign keys may opt in
  with the `-- assistant:migration:foreign_keys_off` marker; the runner disables
  FK enforcement only for that migration, runs `PRAGMA foreign_key_check`, and
  re-enables enforcement before continuing.

## Working notes

- Keep SQL contained in this subtree; consumers should call `sessionStore` or
  narrower facades.
- Update migrations and TypeScript row mapping together.
- After adding a migration, run
  `pnpm --filter @assistant/server migrations:lock` and commit the updated
  `migrations.lock.json`. Never edit an already-applied migration to change the
  schema — revert and add a new forward migration (the lock guard enforces
  this).

## Verification commands

- Run `pnpm --filter @assistant/server typecheck` for this subtree.
- Run root `pnpm run build` before closeout.
