# Claude session records

How a Claude SDK session's own record is stored under `DATA_DIR/claude-sdk/`,
and why persisting one costs what changed rather than what the session holds.
`app/server/src/claudeSdk/claudeSdkRecords.ts` owns the format; nothing else
reads or writes these files directly.

## What the record is, and what it is not

A Claude SDK session keeps its committed timeline in process
(`ClaudeSdkSession.committed`) and persists it with its metadata: title,
provider session id (the `resume` handle), model, thinking level, mode, persona,
cwd, credential profile, fork origin, and cumulative usage. The store rehydrates
it when a command drives the session (`claudeSdkStore.acquire`). Showing a
session never reads it: the transcript the browser paints comes from the
app-owned log (`DATA_DIR/sessions/<id>/log.jsonl`, see `session-loading.md`).

The record's entries are NOT a copy of that log, although the two have about the
same size. Measured across the 1,136 production records on 2026-09-29:

- the ids differ (`csu-…`/`csa-…` in the record, `e<seq>-…` in the log), except
  for a fork's inherited prefix;
- 57 sessions have a different number of message and card entries;
- fields differ on entries that do correspond: `toolName`, `clientRequestId`,
  `origin`, `peerPrompt`, `providerMessageId`, `startedAt`/`completedAt`.

The harness reads its own entries for the commit tool's transcript, skill-load
and tool-exposure accounting, question-tool repair, and context info. Deriving
them from the log would change what those see, so the record keeps its own.

## Two files

| File                 | Holds                                      | Written                                   |
| -------------------- | ------------------------------------------ | ----------------------------------------- |
| `<id>.json`          | metadata + `entryLog` (extent and figures) | whole, atomically (temp file + rename)    |
| `<id>.entries.jsonl` | the committed timeline, one entry per line | appended; replaced whole only when needed |

`entryLog` is `{ count, bytes, messages, assistantTurns, usageTurns }`:

- `count`/`bytes` are the EXTENT the metadata vouches for. Only the first
  `bytes` bytes of the log are part of the record.
- `messages` (`displayMessageCount`, which equals
  `entriesToDisplayMessages(entries).length`), `assistantTurns` and `usageTurns`
  are what the metadata row (`session_index`) and the session list need. Every
  one is additive, so an append counts only the entries it adds, and nothing
  that lists or counts sessions reads the timeline.

The `.json` file is still the one whose existence says "a record exists", so
`sessionInspection.ts` (`resumableState`) and `sessionAuditSources.ts` check it
unchanged. `taskOverhead.ts` reads the timeline through `readClaudeSdkRecord`.

## Persist

The committed timeline is append-only: entries are pushed and never edited or
removed. A clear forgets the provider session id and keeps every entry; a fork
creates a NEW session id whose record is written whole. The store keeps a cursor
per live session (where its log's extent ends) and each persist:

1. appends the entries past the extent (none for a title, mode or model change);
2. rewrites the metadata to a temp file and renames it over `<id>.json`.

The extent is a count of BYTES, and the log is parsed as bytes: UTF-8 never puts
a newline byte inside a multi-byte character, so a line boundary is a `0x0a`
byte whatever the text. (Comparing it with a decoded string's length would call
every non-ASCII transcript damaged and rewrite it on every load.)

It writes the whole log (temp file + rename, then the metadata) only for a
session with no durable log yet (a new session, a fork child, a re-created id, a
legacy record), for a log with an unreadable line in the middle, or for the
repair described under [one writer](#one-writer).

A persist from an instance the store no longer holds (removed, released, or
superseded by a later acquire) writes nothing, so a late event cannot put a
deleted record back on disk. Releasing an idle session is why that is safe: the
release persists one last time and goes only if that write succeeded, and a
released instance refuses to run
([session loading](session-loading.md#letting-go)).

## Crash safety

The metadata rename is the commit point.

- A crash during or after an append, before the rename, leaves bytes past the
  extent. Reads ignore them, and the first write after a load cuts them off
  before appending — but only when no metadata on disk vouches for them (its
  extent is not past the cursor's, or it vouches for bytes the file does not
  hold, as in a salvaged log). Bytes another writer appended and published go to
  the check under [one writer](#one-writer) instead.
- A failed write says where the next one starts (`ClaudeSdkRecordWriteError`'s
  `next`): after a failed append or metadata rename, at the old extent with the
  tail re-checked, so the half-written bytes are cut off and the entries
  appended again; after a failed whole rewrite, another whole rewrite.
- A log that holds less than its extent is salvaged: every complete entry loads,
  a last line without its newline is dropped, and the figures are recounted. The
  next write continues appending from there. A complete line in the middle that
  does not parse is skipped, and the log is rewritten from what loaded. Reading
  never changes a file.

Writes are not `fsync`ed, the same as before this format. A process crash loses
nothing that was written. A power loss can lose the last persist, and the rules
above keep what is left readable.

## Unreadable is not missing

Only a file that does not exist (`ENOENT`) counts as absent: no metadata file
means no record, and a metadata file whose log is missing loads with an empty
timeline, as the salvage above. Anything else — a permission or I/O error on
either file, or metadata that does not parse — throws
`ClaudeSdkRecordReadError`, and nothing is written:

- `acquire` fails with the error, and no session is created. A session started
  empty over an unreadable transcript would replace it with its next persist.
- `exists` reads nothing and never throws: a present metadata file counts,
  readable or not, so routing still sends the id to this harness and only
  driving it fails. One damaged record never breaks a connection: a deep link to
  it still completes `ready`.
- A deep link or `loadSession` to a PRESENT record that yields no view never
  ends with neither a view nor an error. It reports an `error` targeted at that
  session with `sessionUnavailable: true` ("This session cannot be opened: …"):
  the record's read error when it has one — found by reading the WHOLE record,
  log included, since sound metadata can sit on an unreadable log — and
  otherwise that there is nothing to show it from. The web then shows the
  route's stage as unavailable instead of pending (`UnavailableSessionPanel`).
- A REGISTERED session (one with a `sessionStore` row) whose record is
  unreadable still opens: its view comes from the app-owned log, which is
  independent of the record, and nothing reports a problem until it is driven,
  which then fails with the read error and writes nothing. That is intended —
  showing a session never touches the harness record
  (`app/server/src/CLAUDE.md`, the view rule).
- A live session's persist is refused, and logged, when the log cannot be
  checked (its size, or its content for the one-writer check below). The cursor
  stays where it was, so a later persist retries the same step rather than
  rewriting the log.
- The session list skips an unreadable record with an error, and deleting a
  session still deletes its files; only its native transcript, which the record
  would have named, stays behind.

## Backups

A file-level backup copies `DATA_DIR` while the server runs
(`deployment.md#host-and-data`), so a snapshot can hold the metadata and the log
from different moments.

- Log copied AFTER the metadata (longer than its extent): the tail is ignored,
  as after a crash. The snapshot holds the record as the metadata last committed
  it.
- Log copied BEFORE the metadata (shorter than its extent): every complete entry
  the log holds loads, and the figures are recounted from them —
  `readClaudeSdkRecordMeta` reads the log whenever it is shorter than the
  extent, so the session list is right too. The turns appended between the two
  copies are not in the snapshot; nothing else is lost, and the session goes on
  appending from what it has.
- The snapshot also holds the running server's lock file. A restore into another
  directory takes it over (`deployment.md#one-server-per-data-directory`).

**Restore only into a stopped server.** Every append checks the log's SIZE
against the cursor, not its content, so a log replaced from outside while the
server runs by one of exactly the same length (a restore over a live directory,
for one) is not detected, and the server goes on appending to it. That is
outside the contract (one server per directory, stopped before its files are
replaced); a restore into another directory is fine.

## One writer

The cursors are process-local, so the format assumes ONE writer per record. Two
servers on one `DATA_DIR` could each append a different next turn and publish
its metadata, and one turn would silently replace the other. The server refuses
to start while another live server holds the directory
(`deployment.md#one-server-per-data-directory`).

As a backstop, every append first checks that the log's size is exactly the
cursor's extent. The only expected difference is a longer file on the first
write after a load or a failed write, handled above. Any other difference means
something else wrote the log:

- if every complete entry the log holds is the matching entry in memory, the
  session holds all of it and more, so the log is rewritten from the session
  (logged as a warning);
- otherwise the write is REFUSED and logged as an error. The file is left alone,
  the cursor is unchanged, and every later persist of that session refuses again
  until the conflict is resolved.

## Legacy records

Before 2026-09-29 a record was a single pretty-printed `<id>.json` with
`entries` inline, rewritten whole on every persist. Such a file is recognized by
its `entries` array and stays readable as is. Nothing migrates it in bulk. It is
rewritten into the two-file form by its session's first persist after an
acquire, which costs one full write. Until the new metadata replaces the legacy
file, the legacy file is still the record, and a stray `.entries.jsonl` beside
it (a migration interrupted in between) is ignored.

## Cost

Measured on a copy of a 14.8 MB production record (2,934 entries), driving
`claudeSdkStore` itself (`/tmp` data dir, Node 24):

| operation                         | legacy format | two files |
| --------------------------------- | ------------: | --------: |
| persist at turn end (+12 entries) |       ~120 ms |    ~18 ms |
| persist, metadata change only     |       ~115 ms |   ~9.5 ms |
| persist with no change            |             — |   0.24 ms |
| rehydrate (`acquire`)             |        ~81 ms |    ~45 ms |
| first persist of a legacy record  |             — |    ~88 ms |

What is left of a persist is the SQLite metadata-row upsert (~9–10 ms whenever
the title or `updatedAt` moves, the same for a one-entry session) plus the
appended bytes. None of it grows with the transcript. Rehydrating still parses
the whole timeline, because a driven session holds it in memory, but it happens
once per acquire and never on a view path.
