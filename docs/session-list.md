# Session list rebuilds

What one rebuild of the session list costs, and the rules that keep it bounded
by what is shown rather than by what the database has accumulated.

The hub rebuilds the rows a write reported (`hub.mergedSessions` →
`sessions.ts`'s `listSessions` with `onlyIds`; see "Touched rows" below): up to
~4 times a second while agents stream, about 30 times in four minutes with two
or three agents running. Every rebuild runs on the thread that serves every
connection, so its cost is latency for everyone. The flush then sends only what
changed: single-row `sessionUpdated`s when the row set is unchanged, the full
`sessions` list otherwise (`planSessionListSends` in `hub.ts`).

## What it cost

Measured with
`pnpm --filter @assistant/server measure:session-list --data-dir /home/alice/assistant-data`
on a copy of the production database (~4,300 sessions: 257 in the default list,
2,245 with the archive). Medians of 30 runs:

| part                                     |  before |   after |
| ---------------------------------------- | ------: | ------: |
| `worktreeIdBySession`                    |  7.7 ms | 0.01 ms |
| `projectStore.sessionProjectIndex`       |  5.3 ms | 0.01 ms |
| `objectRefsBySession`                    |  4.5 ms | 0.01 ms |
| missing-worktree probe (default rows)    |  3.7 ms |  1.3 ms |
| missing-worktree probe (with archive)    | 12.9 ms |  2.0 ms |
| Task progress index, after a Task write  | 43.2 ms |  1.1 ms |
| **default list**                         | 23.4 ms |  4.8 ms |
| default list, right after a session edge |       — | 21.9 ms |
| **list with archive**                    | 58.7 ms | 27.7 ms |
| **one row (`broadcastSessionUpdated`)**  | 58.7 ms |  0.4 ms |

Before, `broadcastSessionUpdated` built the whole list with the archive to send
one row. `onlyIds` existed, but the rows were still read from the store in full
and then filtered, which alone cost 33 ms.

What is left of a default rebuild is mostly reading and mapping the listed
`session_index` rows (~2 ms). What is left of the archive variant is the same
work for 2,245 rows (~16 ms). The archive variant is built only while some
connection has the archive view open.

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

The hub's sink coalesces touches (25 ms debounce, 250 ms under churn) and
rebuilds only the touched rows (`onlyIds`), or every row on a global touch or
before the first publish. It compares each against what it last published per
archived variant (`publishedSessionRows`), with hidden rows absent and `file`
stripped. The shared predicate (`permanentAssistantVisibility.ts`) is separate
from the singleton runtime, keeping the hub dependency acyclic. Binding an
ordinary legacy row as the singleton removes its public membership; clearing
that binding reveals it again. A variant gets the full `sessions` list when its
row set changed, the archived count moved, or more than `SESSION_DELTA_MAX_ROWS`
rows changed; otherwise one `sessionUpdated` per changed row. A forced touch
(`hub.broadcastSessionUpdated`, used before a refusal's error) sends the row
even when it is equal. The singleton Personal Assistant's row never travels as a
row, only as `permanentAssistantUnread`. Removing its binding publishes false,
including to later connections, only if that scalar changed. A caller whose
reply or later broadcast must follow the list (`mutationSettled`, a Workflow Run
list after its roles) awaits `hub.sessionRowsSent()`.

A failed build or send retains its captured touched ids, forced ids and global
refresh intent alongside any reports received during that attempt. Published
rows, archived count and singleton-unread cache advance only after successful
publication. An awaiting caller rejects on failure rather than acknowledging a
row that was not sent. There is no automatic retry loop: the next ordinary
report retries the retained work, and the audit still recognizes it as reported.
A partially completed send may be repeated on that retry.

Two backstops catch a writer that forgot to touch:

- **Audit (tests).** Under Vitest every flush first builds every row and throws
  `unreported session row change: <id> <fields>` for a row that differs from the
  published one without a touch, before anything is published, so a full-list
  fallback cannot hide it. `hub.setSessionListAuditForTests(false)` pauses it
  for a test that counts store reads.
- **Sweep (production).** Every 60 s (`startSessionListSweep`) the hub advances
  the deadline watermark, compares a full build with what it published, logs
  each unreported row once with its changed fields, and touches it, which
  repairs it. Nothing relies on it.

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
- `app/server/src/sessionDelta.test.ts` shows that `broadcastSessionUpdated`
  reads only the named row and sends exactly what a full build lists.
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
