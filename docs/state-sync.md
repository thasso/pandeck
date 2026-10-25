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
- The state topic kernel (`stateTopicKernel.ts`) carries a migrated topic from
  committed write to wire, one kernel per topic, and its domain supplies only a
  descriptor: revisions for given ids, the summary, the snapshot, an optional
  digest and a batch maximum. `stateTopics.ts` registers the kernels, the hub
  attaches its topic broadcaster to them, and `connection.ts` routes a kernel
  topic's subscribe and `getStateItems` to its kernel. Background, Projects,
  Tasks and Initiatives run on it; `hub.ts` diffs no domain.
- The change set (`db/changeSet.ts`) is the kernel's write half. A write runs as
  one top-level transaction with a change set, which stamps each topic's touched
  rows inside that transaction with one revision per topic, drawn from the
  topic's own persisted sequence; revisions compare only within a topic. After
  COMMIT, every topic the write enlisted reports its touched ids to its kernel
  once, possibly none. A rollback stamps nothing and reports nothing.
- A store whose stamp another domain's write may reach uses the join-or-open
  touch (`touchStateTopic`). Inside a running change set it joins it: same
  revision, reported after that commit, gone with its rollback. With no
  transaction open it opens its own change set. Inside any other open
  transaction it stamps there with a fresh revision and reports at once; that is
  the one exception to "reported after commit", since node:sqlite has no commit
  hook. If that transaction rolls back, each reported id still publishes once
  from committed state, at its unchanged committed revision, which a client
  already holding that revision ignores. Its callers are the Initiatives'
  fan-out stamp and the Task seam (`notifyTaskChange`), through which a Project
  delete, an Initiative membership write and the knowledge link migration touch
  Tasks; each touch stamps the touched Tasks and the Initiatives holding them in
  one transaction.
- A kernel publishes from reported ids only. A report adds its ids to the
  pending set and restarts a trailing debounce, even an empty report. The flush
  reads revisions for exactly the pending ids and walks them in first-report
  order:
  - a live id upserts with its summary;
  - a known non-member deletes at its stored revision, even one that joined and
    left inside one window, because a subscribe in between may have snapshotted
    it;
  - an id the revision read does not return emits nothing;
  - a live id with no summary stays pending and is logged. The next flush
    retries it, and any later report schedules that flush. The kernel never
    reschedules itself.
- A flush is cut into frames of at most the topic's batch maximum, each with the
  next `seq`. `seq` is an in-memory per-topic counter, kept by the kernel; the
  subscribe answer carries the current value. It exists only to trip resync, so
  it does not survive restarts — a reconnect resubscribes and gets a fresh
  baseline anyway.
- A kernel's subscribe answer is a digest only when the topic declares one and
  the client asked for it, otherwise the topic's snapshot. Items by id follow
  the flush's event rules without consuming a `seq` or touching pending ids.
- Cross-domain effects stay outside the kernel as post-publish listeners. Each
  runs once after every flush, an empty one included, after its frames were
  sent; a throwing listener is logged and stops neither the frames nor the other
  listeners. Background's only listener is the session-list refresh for the
  owner's `backgroundActivity`, which therefore lands one Background debounce
  window after the write. Tasks' only listener refreshes the state of the
  sessions linked to a Task, and of one whose last link just went, since that
  state carries a session's Task back-links.
- Server-internal mutations (agent tools, sweeps such as auto-archive) flow
  through the same seam and mint the same events; there is no second write path.

## Client contract

- One seam in the reducer applies a batch: the client replica (below), which
  `applyEvent` routes every migrated topic to; it has no Task branch. Per event,
  apply iff `revision` is greater than the sidecar map's entry, and return
  changed | no-op with identity preservation — an unchanged row keeps its object
  identity (precedent: `reconcileTaskList` / `reconcileTaskDetails`).
- A mutation dispatches its optimistic event(s) locally and records a pending
  entry keyed by the mutation `requestId`, storing only the touched object ids
  and, for a create, the local temp id. The server never sees temp ids; the
  direct reply settles the temp row against the real object, through the topic's
  `settle` hook. Effects belong to the mutation, not its surface: the
  pull-request card's Task completion uses the canonical optimistic Task event,
  and cleanup uses the same optimistic worktree removal as the worktree page. A
  command spanning domains declares each `{topic, objectIds}` effect so recovery
  re-reads both.
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
  failure surfaces inline per R5 in `app/web/docs/loading-states.md`. A failed
  optimistic Task mutation (rejected or timed out) re-reads through the
  transport's silent, coalesced `resync`: while `tasks` is held it sends one
  digest-less resubscribe, which later failures join, and a failed snapshot read
  releases that wait; while unheld it sends nothing, forgets the touched ids'
  revisions and leaves the topic due a snapshot. Other recoveries, Projects' and
  the pull-request card's linked Task, still re-read their ids with
  `getStateItems`.
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

### Client mutation lifecycle

`lib/mutationLifecycle.ts` owns common mutation request identities, records and
timers in one `useAssistant` ref. It removes a record and clears its timer
before calling a terminal hook, so completion, stamped error, timeout and
unknown retire it once. The core owns each record's settled bit; a descriptor
can wait for fresh authoritative evidence after settle without resetting the
deadline. Its first-settle hook runs once. Descriptors keep domain deadlines,
control keys, recovery and failure policy. Task, Project, workflow delivery and
compaction correlation live in those records, not separate control maps. Replica
item reads retain their own request table and deadlines.

For Tasks and Projects, loss of a connected socket is terminal with **outcome
unknown**. Failed connection attempts do not retire queued, unsent writes: their
control claims, duplicate guards and deadlines remain unchanged. Once the socket
opens, queued writes are in flight and a later connection loss retires them.
After dropping replica reads, the lifecycle removes their pending metadata and
temp-id correlations, invalidates touched revisions synchronously and marks
their topics due a snapshot, even for a create without canonical ids. Controls
release to a fresh `idle`, silently. Dropping this overlay does not reverse
rendered optimism; the authoritative reconnect snapshot or recovery corrects it.
Unknown editors retain their drafts. An absent-entry first local-path save still
closes immediately while connected; only a correlated unknown release restores
that attempt, and never over a later user interaction. A known refusal retains
the current attempted draft for inline Retry, which arms the same unknown
protection. A newer interaction, operation or Project discards that draft
protection; no later authoritative row reconstructs it.

Only recovery obligations survive, without timers or control claims. Reconnect
sends its subscription first, omitting digests for affected topics, then drains
recovery once without replaying commands. A held affected Task snapshot is
recorded before sending so Task `resync` joins it without another unsubscribe /
subscribe pair. Unheld Tasks stay unheld and due a snapshot. Projects retain
targeted `getStateItems` recovery and refresh only the currently open touched
detail, even if the list is unheld. Snapshot failure releases the Task wait, not
its invalidation, and starts no retry loop. Effect teardown abandons migrated
records and recovery without future callbacks; the retained instance is
reusable.

Workflow delivery uses the core's settled bit and its descriptor's run-list
predicate. An authoritative busy action hands off early, before settle; an idle
list completes only an already settled request. An earlier idle list is not
remembered. First settle while held sends the existing unsubscribe/subscribe
pair, retaining the claim and original 15-minute deadline until the list
answers. Unheld settle releases without subscribing. Busy handoff lets the list
reducer remove the overlay without an extra control-result dispatch. Pre-card
refusals release only the click and retain the existing Task failure route.

Compaction is receipt-only: identity and the 30-second timer, but no
touched-list effects, optimistic row or digest claim. Only effect-bearing
pending work blocks shell-cache admission. A matching settle/refusal/timeout
releases the latest receipt immediately, without a separate release timer.
Refusals stay in the inspector and retain arrival announcement policy, never
becoming a viewed-chat runtime failure. See
[compaction window](compaction-window.md#inspector) for exact-id, unknown-only
raw draft recovery.

Workflow and compaction also retire unknown only on genuine connected loss.
Queued-unsent claims survive failed attempts with their original deadlines.
Their terminal hooks release controls once; reconnect recovery adds no reads or
replays, since the normal subscription supplies run/session authority. It must
not release a newer offline claim for the same run. Teardown cancels migrated
timers and drops recovery obligations. Workflow cards are not boot-cache data.

PR-card actions still use the common identity/timer owner but keep their legacy
two-signal map, explicit final finish and wait-until-timeout disconnect policy
until Task-1094, including linked-Task effects. Other tracker callers change
storage only. Migration is selected by descriptor, never by a touched topic.
Wire messages, 30-second and 15-minute deadlines, connected failure surfaces and
replica read ownership are unchanged.

## Client replica

`app/web/src/lib/stateReplica.ts` is the client's one implementation of the
generic mechanics for a migrated topic: Background, Tasks, Projects and
Initiatives. The module has no React and two halves, and `useAssistant` stays
the single owner of both:

- The DATA half is a pure reducer step,
  `applyTopicMessage(descriptor, state, message)`, for a topic's snapshot
  answer, `stateEvents` batch, `stateDigest`, or an answered item fetch. A
  snapshot replaces the held items and parses its revision sidecar; an invalid
  sidecar adopts the items with no revisions. A batch applies the per-event
  revision rule above. A batch that applies nothing returns the very same state
  object, and a value-equal echo advances only the sidecar, keeping the item
  array and every row by identity. A digest over a safe baseline prunes the held
  objects it leaves out, keeping the array when none goes, and keeps the held
  revisions of the ids it names without advancing them. A catch-up answer
  applies as a batch; a recovery answer first forgets its ids' revisions, so it
  replaces the rows even at the held revision. A lost baseline forgets the named
  revisions and keeps every row. A `settled` input, a direct mutation reply
  pairing a browser-local id with the server's, goes to the topic's `settle`
  hook alone; revisions belong to events, so it never touches the sidecar.
- A topic's DESCRIPTOR lends the replica its existing `UIState` fields through
  `read`/`write` lenses, so no component changes. It adapts the topic's own list
  message into the snapshot input (no wire change), and carries the topic's
  policy as hooks. `write` keeps every slice it does not own by reference.
  `adoptSnapshot`, `digest.adoptDigest` and `afterEvents` are also handed the
  replica held before the write.
  - `snapshot` may refuse a message: Projects admit only the canonical
    archived-inclusive list and Tasks only the unfiltered live list, so a
    filtered `projectList` or `taskList` changes nothing. It is handed the held
    items, so Projects and Tasks keep value-equal rows by identity, where
    Background and Initiatives take the rows as given. A Project or Task sidecar
    is adopted only when it covers every row.
  - `place` decides where a newly seen member goes: Background and Tasks
    prepend, Projects and Initiatives append.
  - `adoptSnapshot` sets topic-specific snapshot fields on the written state:
    Background's `truncated` window flag, the Project and Task lists' own fields
    and freshness, the Initiative list's freshness and its held keyed reads.
    Tasks also forget the statuses of held rows the snapshot leaves out (never a
    status an archived body recorded) and re-judge held bodies by `updatedAt`
    and, when the sidecar was adopted, by revision.
  - `afterEvents` gets the events that applied, in order: Projects and
    Initiatives re-read a held detail an event moves past. Tasks re-read a held
    body read at a known older revision, forget a deleted Task's status, and
    apply the `updatedAt` rule when the list changed.
  - `digest` says when the held objects are a baseline (Projects and Tasks: the
    canonical list with a revision for every row; Initiatives: a sidecar this
    hook instance set, covering every row) and sets the topic's flags for a
    digest and for its catch-up. Tasks' digest also forgets the statuses of held
    rows it leaves out and re-judges held bodies. Background declares none.
  - `settle` places a direct reply's object. Only Tasks have one: the saved
    summary replaces the create's temp row, or the row of its id, in place; an
    archived Task's row is removed; a filtered or absent list is left alone.
- The TRANSPORT half is one object per hook instance, held in a ref, so nothing
  in it resets with a socket episode or an effect run. It owns:
  - The last `seq` of each migrated topic. A snapshot or digest rebaselines it,
    and a batch that does not continue it warns and returns the snapshot
    resubscribe. The gapped batch still applies.
  - ONE table of open `getStateItems` requests, each tagged `catchUp` (at most
    one per topic; a newer digest replaces it) or `recovery` (an edit's
    authoritative restore). An answer is complete iff its ids are unique and
    exactly the expected ones. A complete answer applies as its purpose; an
    answer to no open request is dropped. An incomplete answer, an `error`
    stamped with the request id (consumed, never the app's error) and a 10 s
    timeout all fail the request. A snapshot cancels its topic's catch-up, never
    a recovery.
  - ONE fallback: `unsubscribe`, then `subscribe` without `digests`, because
    re-subscribing a held topic answers nothing. It serves digest failures,
    failed requests and seq gaps alike. A descriptor that sets
    `resubscribeOnlyWhileHeld` (Tasks, Projects, Initiatives) gets it only while
    the client holds the topic, so a dropped one is never revived; Background's
    gap resubscribes regardless. It warns
    `[state-sync] <topic> digest fallback: <reason>`, or `recovery fallback` for
    a recovery.
  - A recovery that cannot complete (failed, or still open at a disconnect or
    teardown) loses its baseline: the reducer forgets those ids' revisions,
    which also keeps the shell cache from persisting that list, and the topic is
    marked due a snapshot. Both clear when an admitted snapshot re-seeds it. A
    dropped catch-up needs nothing: its ids still hold their old revisions, so
    the next digest names them again.
  - `resync(topic, ids)`, the re-read after a failed optimistic mutation. It
    forgets the ids' revisions and marks the topic due a snapshot. While the
    topic is held it returns the fallback's pair without a warn, unless a pair
    already awaits its answer, which it joins: that snapshot is read after the
    failure, so it answers both. While unheld it returns nothing. It never
    touches a hold.
  - The wait for a pair's answer ends on the topic's snapshot or digest, on
    `snapshotFailed(topic)` (the server's unstamped collection error for the
    snapshot read, which still reaches the reducer as the list's error), or on a
    disconnect. `snapshotFailed` sends and schedules nothing and keeps the due
    snapshot and the forgotten revisions; the next failure sends its own pair.
  - The one subscribe composer. A topic asks for a digest when it declares one,
    has no pending mutation, is not due a snapshot, and its baseline holds.
    `digests` keeps the order `tasks`, `projects`, `initiatives` and is omitted
    when empty.

Frame batching stays in `useAssistant`; the replica sees messages in the order
they are applied.

## Resync

A `seq` gap while subscribed triggers a resubscribe for a fresh snapshot and a
loud log. A client with settled canonical objects and a revision for every
object requests a `{id, revision}` digest. It keeps equal rows by identity,
deletes cached objects absent from the digest, and batch-fetches changed/new ids
as ordinary events. The digest's `seq` becomes the new tripwire baseline. Only a
canonical full snapshot may replace that baseline or cancel its item catch-up;
filtered list replies are ordinary one-off answers and change neither.
Missing/invalid revisions, an incomplete or failed item batch, and a bounded
item-fetch timeout all fall back to the full snapshot: a resubscribe without
`digests`. A failed optimistic Task mutation takes the same snapshot through the
transport's `resync`. The snapshot returns objects and sidecar revisions so the
next resubscribe is warm. An edit recovery that cannot complete leaves its
objects without a revision, so the next subscribe takes a snapshot rather than a
digest that would keep the rejected value. Archived projections never enter the
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

- Tasks: canonical live summaries plus keyed full bodies. A body's reply
  (`taskDetail`, `taskSaved`) carries the revision it is as of, and a newer
  event re-reads it even when the summary is unchanged: a linked Task's rename
  moves only the revision (`docs/tasks.md`). A touched Task that was ALREADY
  outside the live projection (archived) is reported as a `delete` again, as
  Background work reports a non-member: no list holds it, and the revision is
  what an open body of it compares against. That rests on an invariant: the
  client's `taskList` is ONLY ever the canonical live projection. A list read
  with `includeArchived` must never be stored there, or such a `delete` drops a
  real row. A canonical snapshot or digest names the whole live projection, so
  it is authoritative about absence too: it re-reads every cached body it leaves
  out (archived or deleted, perhaps while the tab was away) and every live body
  whose revision is newer than the one it was read at. A filtered snapshot
  judges nothing. A body read without a revision (an older server) stays on the
  `updatedAt` rule for live rows. Every Task write stamps its rows in its own
  change set. The Initiative fan-out joins that change set, so its failure fails
  the write. The auto-archive sweep is a best-effort follow-up: after the
  triggering write committed and reported, each Task it archives is an ordinary
  Task write with its own change set, and its failure never fails that save. On
  the client, a failed optimistic Task mutation resyncs (see "Client contract"),
  the pull-request card's linked-Task write recovers its id with
  `getStateItems`, and the direct `taskSaved` reply settles a create's temp row
  through the Task `settle` hook.
- Projects: canonical archived-inclusive lean summaries plus keyed full
  documents. Project archive/restore is an upsert; only deletion removes
  registry membership. Every Project write (row, paths and edges) commits as one
  change set. A delete stamps the Project and its child Projects, whose `parent`
  edge its sweep removes, so each child gets an upsert without its parent. The
  Tasks it held are stamped through the Task seam in the same change set, so one
  commit covers the tombstone, the Project, Task and holding Initiative stamps,
  and all three topics report after it. The subscribe answer and `getStateItems`
  come from the kernel, a snapshot (`projectList`) or, when asked, a digest.
  Failed optimistic mutations recover their touched ids with `getStateItems` and
  force a keyed detail read only when that id is open.
- Initiatives: canonical live summaries (neither archived nor deleted) plus a
  keyed graph read (`getInitiative` → `initiativeDetail`, carrying the revision
  it is as of). Archiving is a `delete`, unarchiving an `upsert`, and a write to
  an Initiative already outside the projection is reported as a `delete` again
  with its new revision, as archived Tasks are. A summary reads member Tasks,
  their outside blockers and the live sessions on them, so the Task seam also
  stamps the Initiatives that read a touched Task — as a member or below one, or
  through a Task it blocks — in the same transaction as the Task write, and a
  delete or a move reads the holders it takes the Task from before it writes.
  `sessionStore` reports every session whose liveness a write may change
  (archive, settle, a raised outcome, a tombstone, a new row), which reaches the
  Initiatives on that session's Tasks. Both fan-outs run on hot paths, so their
  walks are pinned to index searches (`initiativeStoreQueryPlan.test.ts`). A
  session tombstone inside a larger transaction stamps the Initiatives through
  the join-or-open touch. The kernel answers subscribe with a snapshot
  (`initiativeList`) or, when asked, a digest with `getStateItems` catch-up; the
  client asks for the digest whenever it holds an answered list. The graph read
  also carries the map's layout, laid out in a worker thread when it is read and
  never from a write or a flush; status changes keep it (`docs/initiatives.md`,
  Layout and placement). The client keeps a few reads keyed by id: a newer
  revision from an event, a snapshot or a digest, or a snapshot or digest that
  leaves the id out marks a held read stale and its open page re-reads it,
  keeping the old graph on screen; an answer older than a revision the tab
  already holds is shown and read again. A Task event never touches it.
- Background work: canonical durable session-owned work items on the
  `background` topic, snapshot-plus-revision-sidecar on subscribe and revisioned
  upserts/deletes on every mutation. It runs on the state topic kernel and
  declares no digest. A touched Claude host epoch fans out to the items whose
  summary carries its state rather than travelling as a second collection.
  Membership is every non-tombstoned row, so terminal history stays addressable
  until the owning session is deleted. Deleting a session IS
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
- Comments: the `commentsSnapshot` subscribe/resync answer and revisioned
  `commentEvents` upserts/deletes carry worktree review threads only. Worktree
  review sets have a separate digest in that snapshot and travel as keyed
  `reviewSetEvents` on mutations; neither collection rides an event. The
  object-addressed broadcaster reaches only connections holding that target, so
  comment streams do not join a domain-wide `broadcastAll` topic. Session
  transcript comments and chat comments remain browser-local and never enter the
  wire protocol.

## Enforcement

- Scenario test (`uiLoadScenario` style, counts): optimistic apply → server echo
  → zero row-identity changes.
- A test that exercises every public write function of a migrated domain and
  asserts the touched objects' revisions moved.
- Architecture-style guard: for migrated domains, mutations travel on the wire
  only as state-change events — no full-collection payload on any mutation reply
  or broadcast.
