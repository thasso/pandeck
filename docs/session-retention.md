# Session retention

The Sessions inbox has three shelves for a user session: the **working set**,
the **Settled** shelf (put down by the user, still in the default list) and the
**archive** (out of the default list, loaded on demand). Settling is the user's
gesture; this document is the contract for the server moving a settled session
into the archive on its own, so the default session list — the one serialized in
every `ready` payload and rebuilt while agents stream — stays the size of what
the user still looks at.

`app/server/src/sessionRetention.ts` owns the lifecycle;
`sessionStore.archiveSettledBatch` owns the write.

## Policy

A settled user session is archived automatically **seven days after its latest
settlement** (`SESSION_AUTO_ARCHIVE_AFTER_MS`). One full weekly cycle keeps
recently finished work on the shelf through the following week; three days was
rejected because it commonly archives Friday's work over the weekend, and
fourteen leaves the default list several times larger than what is looked at.
Re-settling a session restarts its clock: the latest `settledAt` is what ages.

Archiving is not deletion. Transcripts, metadata, links, usage and runtime state
are untouched, and the row is one flag away from the default list again.

## Eligibility

At sweep time a session is archived only when ALL of the following hold. The
first half is asked of the projected `SessionListItem` rows the browser renders,
so retention can never take a session the user could not settle themselves; the
second half is re-asked by the store inside the write transaction, so a row
woken or archived between the read and the write is skipped.

Projected (`selectSettledArchiveCandidates`):

- The row carries an EFFECTIVE `settledAt` — the projection withholds it while
  an outcome newer than the acknowledged revision is waiting — and that
  settlement is at least seven days old.
- The shared `settleBlockedReason()` reports nothing: no running turn, active
  delegation, background activity or retained host, pending approval, question
  or Task choice, and no queued peer prompt.
- No working-set Workflow Run owns the session as one of its roles
  (`workflowRunOwnerBySession`), even while that role is idle between steps.
- No connected browser is viewing the session (`Viewer.viewingSessionId`), so no
  tab ever loses the conversation it is looking at.

Durable (`archiveSettledBatch`):

- `user` scope, live row (no tombstone), not already archived.
- `settled_at_ms` at or before the cutoff, and
  `attention_revision <= attention_settled_revision`.

A skipped session is simply reconsidered by the next sweep. Zero-message claims
never reach the list and are never archived; a draft is listable and ages like
any other row.

## Schedule and failure handling

The sweep runs at boot and hourly (`SESSION_AUTO_ARCHIVE_SWEEP_INTERVAL_MS`),
started and stopped from `index.ts` beside the Task auto-archive sweep. One
invocation runs at a time; an overlapping call answers empty and leaves the work
to the next tick. Every run is best-effort: a failure is logged as
`[sessions] <trigger> auto-archive sweep failed; will retry later` and never
fails startup or a user mutation.

Between selecting the candidates from the projected rows and the store write
there is no `await`, so a turn cannot start on a candidate in between. A turn
that starts afterwards runs in an archived session exactly as it would after a
manual archive.

## Backfill

The first sweep after this rule ships meets the whole legacy settled population
at once. It is ONE list read, ONE store transaction (chunked
`UPDATE … RETURNING` statements under a single `BEGIN IMMEDIATE`, advancing each
row's read mark through its latest update as a manual archive does) and ONE
`hub.broadcastSessions()` for everything that changed — never a commit and a
broadcast per row.

## List generation

The default projection (`listSessions` without `includeArchived`) asks SQLite
for unarchived rows (`sessionStore.list({ excludeArchived: true })`, served by
the partial index `session_index_scope_unarchived_updated_idx`) instead of
loading every user row and dropping the archived ones in TypeScript, so per-row
work and the serialized payload scale with the active rows. The same
`liveDefaultScopeGate` that keeps other scopes out of the list keeps an archived
in-memory runtime from riding back in as a live-only row.
`includeArchived: true` remains the explicit path of the on-demand archive view.

## Recovery

- The archive view (`loadArchivedSessions`) lists archived rows and their count
  as before.
- A direct `/sessions/<id>` link resolves by id (`sessionStore.get`) and
  acquires the session whether or not the default list carries it.
- **Restore** from the archive (`archiveSession` with `archived: false`) also
  UNSETTLES the row: the user asked for the session back in the working set, and
  a restore that left a week-old settlement in place would be undone by the next
  hourly sweep. Manual archive is unchanged.
