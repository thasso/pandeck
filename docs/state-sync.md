# State-change events

The binding sync model for domain list state between the server and the web
client: client and server share one vocabulary of state-change events, applied
by the same shape of state engine on both sides, so optimistic rendering is the
default by construction rather than a per-surface hack. Decided in Task-410
under epic Task-407; the payload findings of Task-409 are the motivating case.
This contract governs every migrated domain; Tasks is the pilot and Projects is
the first Phase 3 adoption.

## The model

A user action posts the mutation to the server AND applies the equivalent event
to the client state engine immediately. The server applies the mutation through
its single write path and broadcasts the authoritative event to every
subscriber. The client applies the echo idempotently: because the resulting
state is identical, object identities do not change and nothing re-renders.
Convergence is observable and testable as "zero identity changes on echo".

Ordering correctness comes from per-object revisions — apply an event iff its
`revision` is greater than the last known for that object — which is idempotent
and order-tolerant. A per-topic sequence number is carried only as a gap
tripwire: it detects a missed event while subscribed and triggers a resync plus
a loud log, never replay. Catch-up after unsubscribe/reconnect is a
`{id, revision}` digest diffed against the client's cached objects. A persisted
event log with replay is explicitly deferred unless digests prove insufficient;
history and audit needs stay on `task_status_events` and comments, never on the
sync mechanism.

For migrated domains this kills snapshot-on-change structurally: what travels on
a mutation IS the event, never a full list. A settled client resubscribes with a
digest; full snapshots remain only for cold start, invalid cache, digest
failure, and explicit recovery reads.

## Wire contract

- Migrated domains broadcast one batched message per flush:
  `{ type: "stateEvents", topic, seq, events }` with each event
  `{ kind: "upsert" | "delete", id, revision, item? }`. An upsert carries the
  domain's summary projection; a delete carries the id only. One `seq` per
  batch; the reducer applies a batch atomically through one seam.
- `revision` travels in the EVENT ENVELOPE and never as a field on the wire
  object. A client cannot predict the server's next revision, so a revision on
  the object would make the echo of an optimistic edit always compare unequal
  and defeat identity preservation by construction. Clients keep revisions in a
  sidecar map keyed by object id.
- Events describe MEMBERSHIP in the domain's canonical live projection, not the
  object's whole lifecycle: archiving a task emits a `delete`, unarchiving emits
  an `upsert`. Digests cover exactly the live projection and stay small;
  archived views keep their explicit request/response reads.
- Event payloads are summaries only (`taskSummaryOf` remains the one narrowing).
  The mutator's direct reply (`taskSaved`) keeps the full item — that is how
  detail views adopt the authoritative body and how a create settles its temp id
  — and drops its full-list rider.
- Broadcast events carry NO `clientRequestId`. A flush coalesces writes from
  several actors, so an event cannot honestly carry one request's id.
  Correlation rides the existing per-mutation channel: `mutationSettled` and
  `requestId`-stamped errors.
- A digest-capable subscribe answers
  `{ type: "stateDigest", topic, seq, entries: [{ id, revision }] }`. The client
  asks for all changed/new ids in one `getStateItems` command; the answer is
  `{ type: "stateItems", topic, requestId, events }`, using the same revisioned
  events as live delivery but not consuming a broadcast `seq`.
- A full Task snapshot carries the live projection's revision entries beside the
  list. They seed the client sidecar for the next digest without adding a
  revision field to any Task object.

## Server contract

- Notify-with-ids IS the revision bump. The domain's change-notification seam
  takes the touched object ids; in the same act it stamps each touched row's
  `revision` from a persisted monotonic counter and schedules the broadcast.
  Bump and notification cannot diverge, and every write path — row updates,
  link-edge writes, comment-count changes — reports through this one seam.
- The flush stays debounced and coalesces per object id. Tasks, Projects and
  Subagents diff the current `{id → revision}` map against the last flushed map:
  changed or new ids emit upserts (reading the current summary), ids absent from
  the live projection emit deletes. Background work, whose history only grows,
  reads the reported ids alone: a reported member upserts and a reported
  non-member deletes (see its entry under the domains below).
- `seq` is an in-memory per-topic counter on the hub; the subscribe answer
  carries the current value, each batch increments it. It exists only to trip
  resync, so it does not survive restarts — a reconnect resubscribes and gets a
  fresh baseline anyway.
- Server-internal mutations (agent tools, sweeps such as auto-archive) flow
  through the same seam and mint the same events; there is no second write path.

## Client contract

- One `applyEvent` seam in the reducer applies a batch: per event, apply iff
  `revision` greater than the sidecar map's entry, and return changed | no-op
  with identity preservation — an unchanged row keeps its object identity
  (precedent: `reconcileTaskList` / `reconcileTaskDetails`).
- A mutation dispatches its optimistic event(s) locally and records a pending
  entry keyed by the mutation `requestId`, storing only the touched object ids
  and, for a create, the local temp id. The server never sees temp ids; the
  direct reply settles the temp row against the real object. Effects belong to
  the mutation, not its surface: the pull-request card's Task completion uses
  the canonical optimistic Task event, and cleanup uses the same optimistic
  worktree removal as the worktree page. A command spanning domains declares
  each `{topic, objectIds}` effect so recovery re-reads both.
- An outcome that lives on a DURABLE object instead of in the reply (the
  pull-request card's `actionError`/`actionMessage`) is this command's answer
  only once the server has shown it started this one — for the card, the patch
  that sets `busyAction`, which is also the write that clears the previous
  outcome. Until then those fields still describe the PREVIOUS action, and the
  object's `updatedAt` moves for unrelated reasons (a watcher poll), so the
  local pending flag owns them: consuming them early would revert valid
  optimism, re-surface an answered error, and drop the overlay in exactly the
  window it covers.
- Rejection recovery is AUTHORITATIVE, never a stored inverse: on a stamped
  error the client restores the touched objects from the server's current state
  (refetch, applied as ordinary events). Restoring a pre-change snapshot could
  erase a concurrent agent or other-tab write with nothing to repair it. The
  failure surfaces inline per R5 in `app/web/docs/loading-states.md`.
- Authoritative events always apply; there is no rebase of pending optimistic
  edits over incoming events. With overlapping edits to one object, the first
  echo may briefly step the row back until the second echo lands; the
  zero-identity guarantee is scoped to the common case of one in-flight mutation
  per object.
- The shell cache persists only settled state, never optimistic rows. It stores
  each migrated domain's canonical objects plus sidecar revisions, so a warm
  start can paint immediately and digest-diff rather than replacing the list. A
  cache missing an object's revision is not digest-capable and falls back to a
  full snapshot.
- Worktree git statuses are cached too, but as a SILHOUETTE, not as state: they
  hydrate into their own `cachedWorktreeStatuses` slice so a cold Projects view
  paints rows at their real height instead of growing each one as its watch
  answers. `worktreeStatuses` stays what this socket episode observed, and
  everything that DECIDES from a status reads it alone — an absent projection is
  unknown, never clean. The remembered record reaches exactly two row builders,
  the Projects tree's and the Project page's, and `worktreeRowStatusAudit` holds
  that by listing both reads AND every status collection a component is handed,
  so a map resolved from the remembered record cannot reach a new surface
  without failing; a surface that DECIDES from a status — which actions to
  offer, what the retire dialog claims, the pull-request page's dirt-and-drift
  line — is deliberately excluded and takes the live record only. A remembered
  status renders as the claim about the past that it is: an aged `fetchedAt`
  dims its axes, and the watcher's first push replaces it. The write merges live
  over remembered so a session that never opened a worktree surface does not
  erase what the browser knew, prunes to the cached worktree list, and is
  scheduled by what the rows would DRAW — which worktrees have a status and the
  shape each one gives its row — never by the counts inside it, which the
  watcher rewrites several times a second.

## Resync

A `seq` gap while subscribed triggers a resubscribe and a loud log. A client
with settled canonical objects and a revision for every object requests a
`{id, revision}` digest. It keeps equal rows by identity, deletes cached objects
absent from the digest, and batch-fetches changed/new ids as ordinary events.
The digest's `seq` becomes the new tripwire baseline. Only a canonical full
snapshot may replace that baseline or cancel its item catch-up; filtered list
replies are ordinary one-off answers and change neither. Missing/invalid
revisions, an incomplete or failed item batch, and a bounded item-fetch timeout
all fall back to the full snapshot; the snapshot returns objects and sidecar
revisions so the next resubscribe is warm. Archived projections never enter the
digest and keep their explicit request/response reads.

## Phases

Every phase ships alone and leaves the app consistent. Phase 0: shared envelope,
`applyEvent` seam, pending queue, and the echo-identity enforcement harness — no
behavior change. Phase 1: tasks pilot — persisted revisions, the notify-with-ids
seam, events replace `broadcastTasks` snapshots and the `taskSaved` list rider,
optimistic save/delete/reorder/status. Phase 2: digest resubscribe for tasks and
the warm shell cache. Phase 3: per-domain adoption through epic Task-407's
per-surface sub-tasks — no page invents its own delta format.

## Adopted domains

- Tasks: canonical live summaries plus keyed full bodies.
- Projects: canonical archived-inclusive lean summaries plus keyed full
  documents. Project archive/restore is an upsert; only deletion removes
  registry membership. Failed optimistic mutations recover their touched ids
  with `getStateItems` and force a keyed detail read only when that id is open.
- Subagents: canonical durable thread registry summaries, with revisions in
  event sidecars; an authorized connection may hold one or more thread-detail
  topics, each with a bounded snapshot/digest/item read and its own
  object-addressed run-event sequence. Assignment/result bodies and transcripts
  never ride either registry payload.
- Background work: canonical durable session-owned work items on the
  `background` topic, snapshot-plus-revision-sidecar on subscribe and revisioned
  upserts/deletes on every mutation. A touched Claude host epoch fans out to the
  items whose summary carries its state rather than travelling as a second
  collection. Membership is every non-tombstoned row, so terminal history stays
  addressable until the owning session is deleted. Deleting a session IS
  `backgroundWorkStore.deleteOwnerSession`: one transaction, through the store's
  ordinary mutation seam, rechecks live work (an active item or a retained host
  epoch) and refuses while any exists, marks the session row deleted, and
  tombstones its history, so subscribers get a delete for exactly those rows. It
  commits whole or not at all: a failed session write leaves the session live
  with its history intact, and the delete reports the failure. Once the row is
  marked, no new work can be admitted for it. Archiving is not deletion and
  keeps the history. One owner's history is unbounded, so id lookups bind at
  most 500 ids per statement and a flush is split into consecutive-`seq` batches
  no larger than the snapshot window. Every boot, right after reconciliation
  marks earlier-process work lost, `tombstoneDeletedOwners` repairs member rows
  whose owner is deleted or has no session row: older builds never tombstoned
  them. One transaction per owner, it changes membership only, keeps rows and
  evidence artifacts, is idempotent, and skips and logs an owner that still has
  live work. Because that set only grows, the SNAPSHOT is a bounded window over
  it (active work first, then the newest history, `truncated` when it cut), not
  the whole membership ([Task-656](pa://task/656)). The window bounds one
  answer, not the domain: a row it left out is settled by definition and arrives
  as an ordinary upsert the moment it changes. There is no cursor to ask for the
  next window, so history older than it is simply not on any client. Because
  that history grows with every background command, no read on the hot path may
  touch all of it: a flush reads revisions for exactly the ids the writes
  reported, by primary key (a reported live row upserts; a reported non-member
  deletes, even one that joined and left inside one debounce window), and the
  snapshot reads active rows through their partial index and then only as much
  newest history as the window needs. `backgroundWorkStoreQueryPlan.test.ts`
  pins those plans. The owning session's `backgroundActivity` rides the ordinary
  session list and never sets `isStreaming`, `runStartedAt`, unread or
  `SessionSnapshot.runState`.
- Comments: one per-`CommentTarget` projection shared by worktree review threads
  and session transcript comments. `commentsSnapshot` is the cold
  subscribe/resync answer; `commentEvents` carries revisioned upserts/deletes
  for touched thread ids only. Worktree review sets have a separate digest in
  that snapshot and travel as keyed `reviewSetEvents` on mutations; neither
  collection rides an event. The object-addressed broadcaster reaches only
  connections holding that target, so comment streams do not join a domain-wide
  `broadcastAll` topic. Chat comments remain browser-local and are outside state
  sync.

## Enforcement

- Scenario test (`uiLoadScenario` style, counts): optimistic apply → server echo
  → zero row-identity changes.
- A test that exercises every public write function of a migrated domain and
  asserts the touched objects' revisions moved.
- Architecture-style guard: for migrated domains, mutations travel on the wire
  only as state-change events — no full-collection payload on any mutation reply
  or broadcast.
