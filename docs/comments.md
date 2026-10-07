# Comments and anchors

The binding model for every comment the app collects, on any surface: a comment
names a TARGET and carries a BUNDLE of redundant selectors. Decided in Task-424;
the vocabulary and the resolver land in Task-425. This document is the contract
for the selector bundle, the resolution ladder and the lifetimes; it governs
worktree review comments, Task comments, and the browser-local comments
collected on transcripts and documents (host files, Knowledge Base files).

Two families share that vocabulary and nothing else:

- **Server-side threads** — worktree review and Task activity. Stored, synced,
  answered and resolved by agents. Only they are RESOLVED on read.
- **Pending comments** — on a transcript passage or a document. Collected in the
  browser, carried into the next prompt as prose, and gone once sent. No server
  record, no thread, no resolver.

Code: `app/shared/comments.ts` (the vocabulary and common wire projection),
`app/server/src/comments/commentStore.ts` (the narrow persistence seam),
`app/server/src/comments/resolveAnchor.ts` (the resolver),
`app/web/src/lib/describeAnchor.ts` (browser selection → bundle),
`app/web/src/lib/pendingCommentStore.ts` (every browser-local list),
`app/web/src/lib/chatCommentPrompt.ts` (their types and prompt prose), and
`app/web/src/components/DocumentComments.tsx` (the document tray).

## Wire and synchronization

Worktree and Task comments use one command family discriminated by
`CommentTarget`: `listComments`, `addComment`, `replyComment`, `resolveComment`,
`editComment`, `deleteComment`, and `attachComments`. `commentsSnapshot` is only
the subscribe/resync answer. Mutations report touched thread ids through the
domain notification seam; the server reads only those threads and broadcasts
revisioned `commentEvents` upserts/deletes to connections holding that target.
For a worktree target, the snapshot also carries review sets with their own
revision digest; set creation, closure, and derived-rollup changes travel as
keyed `reviewSetEvents` on `commentEvents`, never as a collection rider. A
process-wide ownership index, populated by every snapshot and event, resolves
root and reply ids without connection-local state or cross-entry scans.
Per-target notification tails serialize projection reads and revision stamps. On
reconnect the browser reissues `listComments` only for targets whose surfaces
are still holding them, including empty snapshots, rebuilding server ownership
and addressed delivery after a process restart. Unwatch drops the target,
canonical threads and revision sidecar, and replay is capped at the shared
per-connection limit. No mutation reply or broadcast contains the full thread or
review-set collection.

`unwatchComments` is per TARGET, not per surface: the server drops the target
for the whole connection and the browser deletes its cached threads with it.
Where one object can be open on two surfaces at once — a worktree on its route
and in the panel's Worktree tab — the holds are counted in the browser
(`app/web/src/hooks/useCommentWatch.ts`) so the wire sees the union: one
`listComments` for the first holder, one `unwatchComments` after the last
leaves. A surface that calls the actions directly instead takes the other
surface's comments away when it closes.

The persistence abstraction deliberately mirrors that vocabulary and no more.
`worktreeCommentStore` adapts SQLite review rows, and `taskCommentStore` adapts
flat SQLite activity rows. Unsupported operations on flat Task comments are
rejected rather than simulated. Pending comments do not implement this
interface: they remain browser-local and never enter the wire protocol.

## The model

The vocabulary is the W3C Web Annotation Data Model's — a target plus selectors
tried in order of precision. It is a model, not a dependency.

```
target:  worktree path:side @ revision | session entry | task | document
selectors:
  quote     { exact, prefix, suffix }   durable, ALWAYS stored
  position  { start, end }              character offsets into the document text
  block     { id, endId?, occurrence }  structural hint/range, defined per domain
  line      { start, end }              DERIVED at read time — display only
```

The inversion that matters: **line numbers are not identity, they are a
projection.** Line numbers are the most volatile coordinate in a document, and a
Markdown block, a diff line and a chat message are all just text with a grid
over it — so one resolver serves all three and every surface reads lines off the
resolved position instead of matching on them.

`prefix` and `suffix` are `PREFIX_LEN` / `SUFFIX_LEN` = 32 characters of the
surrounding document text. The describer and the resolver import those constants
from `app/shared/comments.ts`; they may not disagree.

## Normalization contract

`normalizeAnchorText(s)` collapses every whitespace run to a single space and
trims. It exists for COMPARISON only.

- Stored selectors keep the ORIGINAL text — `quote.exact`, `prefix` and `suffix`
  are raw slices of the document, whitespace and all.
- Every offset in the model — `position`, block ranges, the resolver's result —
  is a character offset into the RAW document text.
- Nothing ever stores normalized text or reports an offset measured on it.

Getting this backwards is the classic bug in anchoring systems: the offsets then
silently point a few characters off in any document with a blank line or a
double space. `resolveAnchor.test.ts` asserts both halves — raw offsets, and a
whitespace-reflowed body that only the normalized comparison recognizes.

## The resolution ladder

`resolveAnchor(bundle, documentText, { blockRanges? })` walks a ladder and the
first hit wins:

1. **Position** — `documentText.slice(start, end) === quote.exact`. Confidence
   1. The common case, and it costs one string compare.
2. **Block** — the bundle's block id is in `blockRanges`: search `quote.exact`
   inside that block's slice. Confidence 0.9.
3. **Quote exact** — every occurrence of `quote.exact` in the document. One
   occurrence wins outright. Several are scored by how many characters of
   `quote.prefix` match backwards from the occurrence plus how many of
   `quote.suffix` match forwards, and the best wins ONLY if it beats the
   runner-up by ≥ 8 characters of context. Confidence 0.8.
4. **Quote fuzzy** — `approx-string-match` (bit-parallel Myers) with
   `maxErrors = clamp(round(rate * quote.exact.length), 1, 128)`, where `rate`
   is `0.35` for a quote of ≥ 40 characters and `0.2` below that. Lowest error
   count wins; ties break by context score, then by distance to the stored
   position. Confidence `1 - errors / length`, floored at 0.3.

   Those numbers are empirical, from the Task-426 golden run over the real KB: a
   passage that had been copy-edited but was still the same passage drifted by
   up to 31% of its characters, while a genuinely rewritten one sat at 47% and
   above. A short quote has no such margin — at `0.35` a deleted 15-character
   list item matched a neighbouring item 4 edits away — so it keeps the tighter
   rate. The absolute clamp bounds "still the same passage", not cost (the
   matcher is `O(n·⌈m/64⌉)` whatever the budget).

5. **Orphaned** — no position, no line, confidence 0.

Two refusals are part of the ladder, not omissions from it:

- **Ambiguity is an answer.** If the exact quote is present but its duplicates
  are not separated by context (step 3), the resolver orphans. It does not fall
  into fuzzy matching, which would only rediscover the same tie and then break
  it on a tiebreak the user never authorized.
- **The short-quote guard.** If `normalizeAnchorText(quote.exact).length < 12`,
  step 4 is skipped entirely and the anchor orphans unless step 3 already found
  it. A short generic quote (`TODO`, `## Notes`) fuzzy-matched against a whole
  document is the known pathology — slow, and confidently wrong (see
  hypothesis/client#3919).

An honest orphan beats a wrong anchor: an orphaned thread is KEPT and revivable
(a revert brings its passage back), while a mis-anchored one silently lies about
what the reviewer meant.

`confidence` is diagnostics only. The UI branches on `state`, never on the
number.

## States and derived lines

- `anchored` — found at exactly the stored position with the exact text. A
  bundle with no stored position has nothing to be at, so its exact matches read
  as `moved`.
- `moved` — found elsewhere, or found fuzzily.
- `orphaned` — not found, refused as ambiguous, or blocked by the short-quote
  guard.

`line` is derived from the resolved position over the same `documentText` the
caller passed: 1-based, `lineAt` of the position's start and end, from a
line-start index computed once per call. It is for display and agent handoff; it
is never stored and never matched on.

Worktree roots persist the bundle in nullable `anchor_quote_*`,
`anchor_position_*` and `anchor_block_*` SQLite columns while retaining the
legacy line/context columns. Their affixes preserve that domain's existing
three-line context window (rather than truncating it to the browser describer's
32-character default). Historical rows are never rewritten: reads derive their
quote/context/block bundle from `anchor_context_json`, and a re-anchor pass
derives the missing source position when the anchor commit is still readable.
Git's `-U0` hunk map remains the domain-specific structural step: its mapped
line becomes the bundle's `block` range, after which the shared resolver owns
exact/fuzzy fallback and orphaning.

## Lifetimes

The lifetime class of the TARGET decides how much machinery a domain needs:

| class              | domain               | kept                          | resolver                            | storage                |
| ------------------ | -------------------- | ----------------------------- | ----------------------------------- | ---------------------- |
| **Object-bounded** | worktree review      | until the worktree dies       | yes — commits move lines            | SQLite                 |
| **Send-bounded**   | documents (file, KB) | until sent or discarded       | none — painted by quote, sent by it | browser `localStorage` |
| **Turn-ephemeral** | chat transcript      | until the next prompt is sent | none — the transcript is immutable  | browser `localStorage` |

Knowledge entries used to be the one **Durable** class: threads in a git JSONL
log under `.kb/comments/`, re-anchored on every read. That was retired — the
threads were collected, handed to an agent once, and resolved, which is the
pending-comment lifetime with a server in the middle. The logs stay in the KB
repo, unread (`docs/knowledge-base.md`).

A review set is authored two ways, and only one of them is typed by an agent:
directly, through the authoring tools (the only path where a round may be
`blind`), or published by the server from a Workflow Run's submitted assessment
— one closed, visible set per review pass, whose threads that run's fix step
answers and whose author re-checks them there (`docs/agent-workflows.md`,
"Assess and fix"). A set's thread state is the durable record either way: the
fix round's own account of what it did is a claim, the threads are what the user
reads.

Worktree review comments and their review sets die with their spawned worktree.
Review sets are deliberately unavailable on synthetic main checkouts, whose
comment lifetime is branch/retention based rather than worktree bounded. After
Git removes a spawned checkout, one SQLite transaction tombstones the worktree
and deletes all scoped threads/replies and sets; comment insertion rechecks
active state in a write transaction, then removal broadcasts the empty list.
Optional branch cleanup may be retried only while the tombstone holds the
original branch oid. The claim is re-read under the repo lock; cleanup refuses a
checked-out ref, and only proven absence, success, or ref reuse clears it, so a
later same-named branch is never eligible. The synthetic main checkout is never
removed, so roots created there capture a branch-subject owner when creation can
prove one: the most recently started merge in flight is authoritative, otherwise
a branch owns the anchor commit only when its ref contains that commit and its
base ref does not. Ambiguous stacked branches, shared base commits, and failed
Git reads produce no owner rather than a guess. The owner is persisted by
worktree id (with branch name and evidence source for diagnostics), and merge
completion or proven identity-bound branch deletion unconditionally purges
matching roots; replies follow through the parent cascade. Event-time
reachability is never used, so a reused branch name or newly shared commit
cannot cause deletion.

The existing daily server-retention pass remains the backstop, including for
legacy and ambiguous owner-less roots. It first re-anchors every synthetic-main
root, then deletes a thread only when the fresh verdict is `orphaned` **and**
the root has been resolved for more than `MAIN_COMMENT_RETENTION_DAYS = 30`;
replies follow through the existing parent cascade. Neither half is sufficient
alone: an open orphan is still a question somebody owes an answer to, while a
resolved anchored thread still points at live code. A stale orphan verdict is
never trusted, and this sweep is maintenance-only—not a worktree-comment read
side effect.

Historical comments attached to already-removed spawned worktrees are handled
only by the user-reviewed, dry-run-first
`pnpm --filter @assistant/server worktree-comments:sweep` maintenance command,
never by an automatic migration. Pass `--delete` only after reviewing its
`worktreeId → (branch, removedAt, comment count)` report; destructive
classification and deletion are one all-or-nothing transaction.

Chat comments share the composer's browser-local draft namespace: its OUTBOX,
`<draft key>.chatComments`. They accumulate across transcript entries and page
reloads on that device, but create no server record or wire message. Sending
folds the overall draft and its comments into one plain-prose prompt and clears
only the attached comments; dismissing them leaves the draft text intact. This
lifetime ends on the next prompt submission, not when the currently running turn
ends.

## Document comments

A document collects its comments in its own TRAY
(`assistant.documentComments:<document key>`), the same browser-local list kind,
through `DocumentCommentLayer` mounted at the bottom of its viewer: the
host-file viewer, and the worktree file page for the Knowledge Base checkout
(`documentComments` on `WorktreeDetailPage`; route and side panel share one tray
per file). There a Markdown Preview renders with source positions and the File
view renders the shared `CodeBlock` text body instead of the diff surface, so a
passage can be selected in either. A comment is either on a PASSAGE — the
reader's selection, with its rendered quote, its selector bundle for painting,
and the SOURCE lines the renderer names (Markdown blocks' `data-source-line-*`,
or exact lines counted inside a `CodeBlock` window from its
`data-code-first-line`) — or on the WHOLE document when nothing is selected.
Images, PDFs, HTML and other files take whole-document comments only.

Nothing is re-anchored. A passage is painted where its stored offsets still hold
its quote, else at the quote's first occurrence; one that no longer renders is
simply not painted, and is still sent by its quote. Tapping a painted passage
opens its comment for editing.

Sending a tray MOVES its comments into a session composer's outbox — the session
on screen is offered first, a new session receives them on the new-session page
— and takes the reader there. They ride the next prompt with any transcript
comments: one section per document, headed by the file path (a KB file by its KB
path, its `pa://knowledge` link and `kb_read`), each comment as its lines and
quote or "the whole document", numbered across every section. The agent reads
the document itself; no comment tool exists or is needed.

Every pending comment is its own localStorage record, `<list key>#<comment id>`,
never an element of one shared array: tabs share that storage with no lock of
its own, and a list kept as one value loses whichever of two concurrent
read-modify-writes lands first. An append writes a key no one else writes.
Everything that reads before it writes — an edit, a removal, a clear, a move —
holds one cross-tab lock (the Web Locks API, `assistant.pendingComments`), since
localStorage has no compare-and-set; where the API is missing the operation runs
unlocked. Four rules follow from it:

- **A move is per comment, durable before it is a move.** Each comment is
  written under the outbox's key for it and only then removed from the tray. A
  refused write (a full quota) leaves that comment in the tray and is reported
  ON the tray; a tray removal refused after its outbox write is reported too,
  since that comment is then in both places.
- **A move is idempotent.** An outbox record is keyed by the comment's id, and
  an id the outbox already holds is left as it is: a repeated, interrupted or
  raced move neither duplicates a comment nor overwrites an edit made to it in
  the composer meanwhile, and two trays moved into one outbox at once cannot
  overwrite each other. Two tabs sending one tray to two DIFFERENT sessions can
  each deliver a copy; nothing is lost. A composer that sends clears only the
  comments its prompt carried.
- **An edit saves over what it started from, or not at all.** The comparison is
  against storage at the moment of writing, not against what was last rendered.
  A save whose comment another view changed is refused once with the draft kept,
  and a second save overwrites deliberately; a save whose comment was sent or
  removed meanwhile keeps its draft and says so.
- **Text leaves a field only once it is stored.** A new comment or an edit
  storage refuses keeps the field open with its text and the reason beside it —
  the document composer and the chat composer alike — since a tray with nothing
  in it has nowhere else to say so.

An outbox written by an older client — one JSON array at the list key — is still
read, and is migrated into records by the next write to that list.

While a text selection is live in the document, collected passages are not
painted: the native selection owns the paint. A tap on a painted passage opens
its comment even when the passage is linked text; a tap anywhere else on the
link follows it.

One place writes a transcript comment: the composer's own field. Selecting a
pending comment — from the chip's list or by tapping its highlight in the
transcript — loads it there to be edited, alongside cancel and delete, and while
a comment is being written the prompt's own controls (attachments, staged
context, runtime, branches) stand down, because a comment carries none of them.
Nowhere in that field is the passage quoted back: it is selected and highlighted
in the transcript directly above, by the person now typing. The chip beside it
is a LIST, never a preview: a count, then one line of each comment with the full
text on hover, a row that takes the reader to the passage it annotates, and the
two acts a pending comment has. Removing every comment at once is the one act
there that a single row cannot undo, so it asks first — it is not a ✕ next to
the control that collapses the panel.

A comment BODY is Markdown wherever it is shown, at one size, through
`app/web/src/components/common/CommentBody.tsx`: the composer accepts Markdown
and agents write it, so a surface that rendered it as literal text was the app
disagreeing with itself. The exception is a roster row, which shows a plain
first line because it is an index, not the comment.

Task comments stay flat and unanchored — they are an activity trace, not a
review surface.
