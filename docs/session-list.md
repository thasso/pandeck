# Session list rebuilds

What one rebuild of the session list costs, and the rules that keep it bounded
by what is shown rather than by what the database has accumulated.

The `sessions` state topic (`sessionsTopic.ts`, on the kernel described in
`docs/state-sync.md`) rebuilds the rows a write reported (`mergedSessionList`
with `onlyIds`; see "Touched rows" below): up to ~4 times a second while agents
stream, about 30 times in four minutes with two or three agents running. Every
rebuild runs on the thread that serves every connection, so its cost is latency
for everyone. The flush sends each touched row as one revisioned `stateEvents`
event; a full list travels only as the subscribe answer.

## The rules

- **One read per relation, never one per row.** Every per-session relation
  `listSessions` needs is resolved in its batched prologue as one indexed scan
  or one store read. A new per-row lookup belongs there.
- **Link-derived maps are memoized on the edges, not on the clock.** The three
  maps built from `session` edges (`in_worktree`, `in_project`, `context`) are
  wrapped in `memoizedOnLinks` (`db/links.ts`). A memo is rebuilt only when one
  of these changes:
  - this process's write count for edges leaving that node type. Every
    `links.ts` write bumps it, and `removeAllFor` bumps every type because it
    also deletes edges INTO a node.
  - `PRAGMA data_version`, which moves when another connection commits.
  - the connection itself.

  A value built inside an open transaction is never kept, because it may hold
  writes that then roll back. Edge writes therefore go only through `links.ts`
  (`app/server/src/db/CLAUDE.md`). A Task edge does not invalidate the session
  memos. A hit returns the same instance to every rebuild, so the maps are typed
  `ReadonlyMap`, and the context refs are frozen once, when the memo is built. A
  write to a row's ref then throws instead of corrupting every later list, and
  freezing costs nothing per rebuild, where cloning would cost ~1,000 objects
  each time. Rows copy the ref array, so a row can still add or drop refs
  without touching the memo. The other two maps hold strings.

- **What changes without a write is read per build.** Whether a worktree folder
  still exists can change with no write this process sees, so the
  missing-worktree probe is never memoized across builds. It reads the active
  worktree rows once per build instead of once per id, and reads each distinct
  id's presence answer once. A changed presence answer
  (`worktrees/checkoutPresence.ts`), including forgetting a verified absence,
  and every write to the main-checkout caches (`worktrees/worktreeResolve.ts`)
  touch the sessions reading it.
- **Count from the columns a count needs.** Per-session Task progress is still
  cached on `taskIndexVersion` and the Task-edge epoch, so direct context-edge
  removal also invalidates it. The rebuild after a Task write used to assemble
  every Task summary just to count statuses. It now reads one join over the same
  Tasks and edges (`taskStore.sessionTaskStatuses`).
- **`onlyIds` bounds the reads, not only the result.** A one-row refresh passes
  the id down to `sessionStore.list({ ids })`. Every row is computed from its
  own inputs, so the one row equals the same row in a full build.

## Owed peer replies

Each rebuild also reads who each session still owes an answer after its last
reply reminder (`peerPromptStore.remindersExhaustedByRecipient`, projected as
`unansweredRequestsFrom`, requesters newest first): one grouped read over the
`awaiting_response` rows whose `reminder_count` reached
`sessionPeerPromptReminderLimit`, from a user session neither archived nor
deleted, served by `peer_prompts_expiry_idx`. A change of the limit rebuilds
every row; nothing clears the field but a reply, a settle or the request's
deadline passing the watermark (below).

Each rebuild also reads who still owes each session a reply
(`peerPromptStore.outstandingRepliesBySender`, projected as
`awaitingRepliesFrom`): one read over the `awaiting_response` rows, each tested
by two `NOT EXISTS` probes — "a later admitted prompt from the owed peer" and "a
later admitted prompt from a session the owed peer handed the work to since the
request, on that handoff's chain" (the handoff's chain, not the request's: a
user prompt closes chains, so a handoff after one travels on a fresh chain). The
first probe is one exact seek on (recipient, sender, `queue_seq`) from
`0065_peer_prompt_reply_lookup.sql`; the second walks the owed peer's later
sends (`peer_prompts_sender_idx`) and seeks each handoff's report on (recipient,
chain, `queue_seq`) from 0065. An earlier single probe joined by `OR` could seek
only the recipient and scanned everything the sender ever received; split, the
probes would also seek the older sender and chain indexes, reading the owed
peer's later sends or the whole chain, so 0065's header overstates the gain. The
seeks keep the cost bounded by what is owed and what the owed peer sent since,
rather than by history. A request already marked `replied` whose correlated
reply was cancelled or failed before delivery stays owed; that half starts from
the lost replies and follows the `replied_by_message_id` back-link
(`0066_peer_prompt_replied_by_index.sql`). `peerPromptStore.test.ts` pins the
plan. A request its recipient settled (`settled`, Task-942) is not owed: the
read takes only `awaiting_response` and lost-reply `replied` rows. Any delivered
message from the owed peer counts as a handoff, so a peer that only asked a
sibling something on their shared chain is cleared by that sibling's own report
— the same rows as a real forward. Measured on a copy of the production database
(7,539 peer prompts, 16 senders owed): 0.24 ms median.

## Touched rows

A write that can change a `SessionListItem` reports WHICH rows, through the one
seam `db/sessionListChanges.ts`: `touchSessionRows(ids)` at the write site,
synchronously, inside its transaction when one is open, before the writing
function returns. It names every session whose row the write may change, fan-out
included:

- a peer request's sender and recipient, the coordinator's other held children
  (their `waitingForSlot` positions), and the senders waiting on this row's
  sender through a handoff (`awaitingRepliesFrom`'s second probe). Terminal
  pruning reads these dependents before deletion, just like transitions;
- both ends of a `links.ts` edge, and every session linked to a Task whose
  status, title or existence changed (`taskStore.contextSessionIds`);
- every session in a worktree whose row was inserted, updated or removed, and
  the owners of background hosts that changed;
- the live engines' map entries: a pi or Claude session that opens or leaves
  memory overlays the persisted row, so both stores touch it. Pi model/thinking
  commands await the engine's effect, then synchronously report the row before
  the command resolves. Native callbacks are write boundaries too: pi's
  `message_end` exposes a newly appended native message count before the next
  tool/provider step. Claude reports canonical appends (including steers
  accepted by a command-lifecycle callback) and observed model changes without
  waiting for a later terminal persist. Clearing Pi's live naming indicator is
  itself a write, even if native title persistence then rejects before its
  callback. Automatic naming logs that rejection and stops the indicator.

Test-owned clears follow the same contract: removing direct-child membership
reports the removed children, dropping hold tickets reports the held siblings,
and resetting presence reports keys whose verified absence was forgotten. They
do not disable the audit or reset the published baseline.

Over-touching costs one row rebuild; under-touching leaves a stale row. Deferred
reporting (`void import(…).then(…)`, a post-publish listener) is not a touch,
because another flush could see the change first. `touchAllSessionRows` is only
for inputs every row reads with no bounded id set: the reminder-limit setting, a
cleared pull-request card table, a closed database.

A touch stamps each id's `session_list_revisions` row with a fresh revision in
the write's change set (`db/changeSet.ts`); the committed ids report into the
kernel, which coalesces them (25 ms debounce, 250 ms under churn) and builds
only those rows, in one `mergedSessionList` call per flush. Every touched id is
published at its new revision, even when its content did not change. A listed
row is an `upsert`; an archived, tombstoned, hidden or zero-message row is a
`delete`, which a client holding nothing for that id ignores. The singleton
Personal Assistant never travels as a row, only as `permanentAssistantUnread`,
which a listener recomputes when the singleton's revision moved.

The subscribe answer, `sessionList`, carries the live rows (archived rows
excluded), their revision sidecar and the archived count. Connect pays for that
one build; `ready` carries no session fields. A subscribe asking the `sessions`
digest is answered instead by `stateDigest` with the same rows' `{id, revision}`
pairs, followed by one `archivedSessionCount`; the client fetches new and moved
rows with `getStateItems` (`docs/state-sync.md`, "Resync"). The digest still
costs the server one full build; it saves the transfer and the client's
replacement of unchanged rows. The shell cache keeps rows at rest
(`sessionListItemAtRest`), with a revision only for rows that were already at
rest. Optimistic session and Workflow Run settles also discard the predicted
rows' revisions until session authority confirms them, because a stale workflow
view may predict peers or roles the server does not settle. A reconnect or warm
start re-reads moved rows, rows that were live, and unconfirmed settle
predictions. A server restart touches every row, so the first digest after it
re-reads them all.

### Republishing a row

A caller whose reply or later broadcast must follow the rows (an `error` after a
refusal, `mutationSettled`, a Workflow Run list after its roles, the
`forkedSession`, `draftSession` and `permanentAssistantOpened` route replies)
calls `publishSessionRowsNow()` outside transactions first: it flushes what is
pending, synchronously, so the rows precede the reply on every socket. A refusal
that must re-send a row the write did not change touches it first
(`hub.republishSessionRow`), which stamps a new revision, so a client holding an
optimistic guess at an older revision adopts the authoritative row.

Failures stay in the topic (Task-1310, `docs/state-sync.md`, "Failure
boundary"): a failed row read or frame send is logged, its ids are retained and
publish on the next ordinary report, and the command that caused the flush still
succeeds. There is no retry loop. A retained id repeats at the same revision,
which a client already holding it ignores; a connection that missed a frame sees
the `seq` gap and resubscribes.

### Archived sessions

Archived rows never enter the client's replica, so a `delete` for an archived id
cannot drop a shown archived row. A client reads the archived slice on demand
with `loadArchivedSessions` and its `requestId`; the server answers
`archivedSessions` with that id (archived rows only), or, if the build fails, an
`error` with the same id and the target `{ type: "session" }`. An
`archivedSessionCount` broadcast on the topic tells clients the count moved; its
last-sent value is seeded at boot and advances only after a send that did not
throw.

While the slice is shown, the client re-reads it when the count moves or a
`delete` arrives for an id the slice holds; a live `upsert` for such an id is a
restore and moves it to the live rows. Reads are single-flight with at most one
queued, released by their own answer or error, a disconnect, or a 30 s timeout;
an answer or error carrying another `requestId` is ignored. Collection errors
are consumed here or by the snapshot transport, without changing the viewed
chat's runtime, streams or error. If a disconnect drops an in-flight or queued
read, the client preserves one pending read and sends it only after the
reconnect's `sessions` snapshot, or its digest once every moved row is fetched.
Either marks the slice stale, so an open shelf gets exactly one fresh read.

### Audit

Two backstops catch a writer that forgot to touch:

- **Audit (tests).** Under Vitest every flush, item read and snapshot first
  builds every row (archived included) and compares it with the baseline: a row
  whose public content or presence changed while its revision did not move above
  the one the baseline recorded raises `StateTopicInvariantError`
  (`unreported session row change: <id> <fields>`). The invariant is recorded in
  a worker-wide ledger the test setup fails on, even if a command or socket
  boundary converts the throw into a routine error; only `sessionsTopic.ts`
  constructs one, and code recognises it by brand (`isStateTopicInvariant`),
  never by `instanceof`. A delivered publication moves the baseline of each id
  it published. While a global touch's publication is owed, a row archived in
  both builds is excused, since the global touch stamps only the live superset.
  Global stamps retain their preceding explicit revision for membership checks,
  so they never excuse archive/unarchive, appearance or disappearance. Explicit
  reporters inside the window still cover their transitions. Provenance is
  matched against SQLite's committed revision, retained across failed delivery
  and rollback, and cleared after the global publication or database
  invalidation. That publication checks against the old baseline before
  installing delivered rows, then recaptures. Ordinary pre-flush checks do not
  recapture pending ids: a later read or send failure must leave their previous
  delivered baseline intact, so the retained touch still covers its retry.
  `setSessionListAuditForTests(false)` runs a test as production does.
- **Sweep (production).** Every 60 s (`startSessionListSweep`) the topic
  advances the deadline watermark, compares a full build with the baseline, logs
  each unreported row once with its changed fields and touches it, which repairs
  it, then retries retained ids. Nothing relies on it. Boot touches every row,
  captures the baseline and seeds the archived count before serving.

Closing the database (`closeDb`) forgets the baseline; a global touch with the
database closed only invalidates and never reopens it.

A main checkout's cached "no repository" verdict keeps its existing 60 s TTL.
`worktreeResolve.ts` reports the expiry synchronously before marking the cached
absence expired. An unref'd timer performs that transition for idle sessions;
every TTL-reading path also performs it if the timer has not run. Thus a read
past the TTL sees the same candidate verdict as before, but cannot expose it
before the touch. Invalidating, replacing or clearing an entry cancels its
timer. The 3 s and 10 min resolve-freshness TTLs only trigger asynchronous
validation; they do not change the synchronous row verdict.

### Deadline watermark

A peer request stops being owed when its reply deadline passes, with no write to
say so. Peer fields therefore read `deadlineWatermark()` W
(`db/peerDeadlineClock.ts`): a request reads as expired exactly when
`expires_at_ms <= W`. W moves only inside `advancePeerDeadlines(now)`, which
first touches the sender and recipient of every request whose deadline lies in
(W, now], then sets W; it never moves backwards.

A timer runs it at the next deadline after W over a deliberate superset of
statuses: every status from which a `response_requested` request is, or can
still become, owed (`held` through `replied`). No transition leaves
`settled`/`failed`/`interrupted`/`cancelled`/`expired` (`transitionInTxn`
refuses to), so a deadline stays scheduled from the write that stores it until
its request closes for good. Every write of `expires_at_ms` calls
`noteDeadline`, which arms earlier when needed. The delay is clamped to
`setTimeout`'s 2^31−1 ms (the 30-day reply TTL exceeds it; an early fire only
re-arms) and `unref`'d; a failed advance keeps W and retries after 60 s.
Retention (`runPeerPromptRetention`) advances W before it expires and prunes
rows, so those transitions change no row. Both queries seek
`peer_prompts_expiry_idx`, one seek per status for the next deadline
(`peerPromptStore.test.ts` pins the plans).

## Children waiting for a slot

A directly spawned child over its coordinator's concurrency cap is created with
its opening prompt `held` (`docs/agent-workflows.md`). Each rebuild reads every
held row once (`peerPromptStore.heldQueue`, pinned to the partial
`peer_prompts_held_sender_idx`, already in sender and `queue_seq` order) and
ranks it within its coordinator's rows (`heldDirectPeers.ts`
`waitingForSlotByChild`). A row the start pass may not pass yet, admitted but
still being created, counts too: the rank adds the coordinator's older in-flight
hold tickets, read from their one owner in `peerSpawnRuntimes.ts`. The
`session_spawn` result reports a position by the same rule, so the two never
disagree. The row carries `waitingForSlot: { position }`; nothing else stores
it. Every held transition (insertion, a start by the pass or by Send now, a
refusal, a withdraw or stop, an archive or delete) touches the coordinator's
held children, and Send now touches them when it claims the row, before the
delivery is appended.

**Zero-message rows.** A row with no message is a runtime's metadata claim, not
a conversation, and stays unlisted, with two exceptions: a draft, and a child
the direct `session_spawn` path recorded (`direct_peer_children`). The recorded
child is listed from creation, while it waits, and after its start was refused
or cancelled, until the user settles, archives or deletes it. Which zero-message
rows are recorded is one primary-key read over just those ids
(`directPeerChildStore.childIdsAmong`). Rows from before the registry existed
are not revived, and the live-only rows are unchanged.

## Provider retries

A running row carries `providerRetry` while its provider reports it is retrying
a failed request (`docs/live-progress.md`). It is read from an in-memory map in
`sessionActivity.ts`, so the build pays nothing for it. That map touches its
session only when a retry starts, reaches another attempt or ends. The rest of a
run's live progress moves on every tool transition and deliberately never
rebuilds the list: it reaches the viewed session through its runtime snapshot
and events.

## What was not done, and why

- **No new `links` index.** An index on `(from_type, relation, from_id, …)`
  still needs a temp B-tree for `position IS NULL`, and it cut the raw scans by
  only ~15%. The cost was materializing ~4,300 rows, not finding them. Once the
  maps are memoized, a cold scan happens only after a session edge write. On
  production that is ~60 a day, most of them at session creation, which rebuilds
  the full list anyway.

## Verifying

- `app/server/src/sessionListMemo.test.ts` compares the memoized list, default
  and archived, with a fresh connection's build after each write: edge inserts,
  relinks and deletes, archive, project removal, a worktree row retired, and a
  session deleted. It also checks that Task progress equals the `listTasks()`
  derivation it replaced, and that the batched probe agrees with
  `sessionWorktreeMissing`.
- `app/server/src/db/linksMemo.test.ts` shows that every write path misses, that
  a Task edge does not, and that another connection's commit, a rolled-back
  transaction and a reopened database all miss.
- `app/server/src/sessionsTopicSweep.test.ts` drives the production sweep
  through each kind of unreported change, a failed global flush and a retained
  id; `db/sessionListLifecycle.test.ts` shows a closed database forgets the
  baseline and is never reopened by a global touch;
  `sessionsTopicOrdering.test.ts` shows each reply follows its rows' events.
- `app/web/src/sessionTopicScenario.test.tsx` and the `sessions replica` and
  `archived session reads` cases in `hooks/useAssistant.test.ts` pin the client:
  live rows only, revision order, a `seq` gap resubscribe, and the archived
  slice's single-flight read.
- `app/server/src/sessionListReporters.test.ts` guards export classifications
  (including in-memory exported classes/owners), fan-out, audit, sweep and wire
  parity. Its source-name checks are secondary guards, not behavioral proof.
- `sessionListBehavior.test.ts` independently rebuilds both public variants
  before/after real writes and collects touches before synchronous APIs return.
  It checks every changed id, including indirect dependents. Equal-public
  transitions state their reason and assert their durable effect. Engine tests
  replace provider construction/snapshots, not row construction or diffing.
- `sessionListOwnerInventory.test.ts` classifies every concrete method of both
  stores, both live classes and `SessionRuntime`, plus native switch callbacks.
  New methods/cases require classification; evidence references are navigation,
  not behavioral proof. `piSdk/sessionListLiveWriters.test.ts`,
  `claudeSdk/sessionListLiveWriters.test.ts` and the retained-host oracle
  fixture in `ClaudeSdkSession.backgroundWork.test.ts` execute
  acquisition/fork/cleanup, prompt/error/continuation, delayed naming,
  account/control commands, synthetic/native callbacks and runtime teardown
  against full public builds. Context edits and compaction retain native
  transcript-total counts; usage, context caps and Claude's current retry
  overlay have explicit equal-public checks rather than artificial row changes.
  Promise-like prompt receipts are awaited through completion, while synchronous
  writers are sampled before yielding.
- `sessionListCorrections.test.ts` pins public singleton membership and unread
  state, prune dependencies, touch-before-TTL-expiry (including a delayed
  timer), and touch-before-COMMIT ordering. `sessionListDeadline.test.ts` drives
  the watermark on fake time; `sessionListForcedRefresh.test.ts` shows a refused
  command's row arriving before its error.
- `pnpm --filter @assistant/server measure:session-list --data-dir <absolute data dir>`
  copies the database and the file-backed stores into a temporary directory,
  measures that copy, and deletes it.
