# Session list rebuilds

What one rebuild of the session list costs, and the rules that keep it bounded
by what is shown rather than by what the database has accumulated.

The hub rebuilds the list (`hub.mergedSessions` → `sessions.ts`'s
`listSessions`) after every session change: up to ~4 times a second while agents
stream, about 30 times in four minutes with two or three agents running. Every
rebuild runs on the thread that serves every connection, so its cost is latency
for everyone. The flush then sends only what changed: single-row
`sessionUpdated`s when the row set is unchanged, the full `sessions` list
otherwise (`sessionListDelta` in `hub.ts`).

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
  worktree rows once per build instead of once per id, and calls `existsSync`
  once per distinct id.
- **Count from the columns a count needs.** Per-session Task progress is still
  cached on `taskIndexVersion`, but that version moves on every Task write and
  comment. The rebuild after one used to assemble every Task summary just to
  count statuses. It now reads one join over the same Tasks and edges
  (`taskStore.sessionTaskStatuses`).
- **`onlyIds` bounds the reads, not only the result.** A one-row refresh passes
  the id down to `sessionStore.list({ ids })`. Every row is computed from its
  own inputs, so the one row equals the same row in a full build.

## Owed peer replies

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
plan. Measured on a copy of the production database (7,539 peer prompts, 16
senders owed): 0.24 ms median.

## What was not done, and why

- **No new `links` index.** An index on `(from_type, relation, from_id, …)`
  still needs a temp B-tree for `position IS NULL`, and it cut the raw scans by
  only ~15%. The cost was materializing ~4,300 rows, not finding them. Once the
  maps are memoized, a cold scan happens only after a session edge write. On
  production that is ~60 a day, most of them at session creation, which rebuilds
  the full list anyway.
- **No touched-rows rebuild.** A trigger that knows its session ids could
  rebuild only those rows. At ~5 ms per default rebuild, the saving does not pay
  for a second path whose correctness depends on every trigger naming every row
  it changed: unread state, attention, pull-request cards and Task progress all
  move rows the trigger did not name. The full rebuild plus `sessionListDelta`'s
  exact comparison stays the one source of truth.

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
- `pnpm --filter @assistant/server measure:session-list --data-dir <absolute data dir>`
  copies the database and the file-backed stores into a temporary directory,
  measures that copy, and deletes it.
