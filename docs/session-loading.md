# Session loading

What happens between clicking a session and reading it, and the rule that keeps
that cost independent of how big the session is.

The target is that opening a session feels immediate whatever it contains — a
five-message chat and a 4,700-message one should paint at the same speed. The
work that used to make the difference was all work nobody could see.

## What it cost, and why

Measured against the running deployment (`loadSession` request → `snapshot`
frame on the wire), before any of this:

| session                | app log | provider transcript |  answer |
| ---------------------- | ------: | ------------------: | ------: |
| 519 messages, pi       |  1.4 MB |               51 MB | 2,251ms |
| 538 messages, pi       |  1.4 MB |               51 MB | 2,611ms |
| 2,924 rows, pi         |   14 MB |               41 MB | 1,333ms |
| 162 messages, SDK      |   14 MB |      31 MB (record) | 1,166ms |
| already resident (any) |       — |                   — |  ~170ms |

The pattern is in the first two rows: a session with a SMALL transcript and a
big provider file was the slowest of all. The cost was never the conversation —
it was opening the harness. `SessionManager.open` parses the whole pi native
file (1.7s for 51 MB, measured in isolation), and the Claude SDK record is one
large JSON document read in full. Neither produces anything the reader sees: the
transcript the browser paints comes from the app-owned log.

Two things were left under it, both invisible until the harness open stopped
hiding them:

- the app log was read, parsed and projected IN FULL — every tool result and
  thinking block previewed — and then all but the last ~130 rows were thrown
  away (144ms of a 2,900-row session, 230ms of a 4,900-row one);
- building the `SessionState` that travels with the snapshot listed EVERY Task
  and EVERY link in the database, twice, to find the handful linked to this
  session: 42ms per call, ~85ms per `state()`, on a session of any size — and on
  every `broadcastState` during a run, not only on open.

## The rule: showing is not driving

**A session is shown from storage. Only a command that drives it opens its
harness.**

- `hub.viewById` answers synchronously with the resident driver if there is one,
  and otherwise with a `ViewSession` (`app/server/src/viewSession.ts`) — the
  metadata row plus the app-owned log, and nothing else.
- The runtime session it attaches to is DETACHED
  (`session/adapters/detached.ts`): it renders, and every drive call throws
  `DetachedSessionError` rather than silently doing nothing.
- The first command that needs the provider — prompt, abort, model, thinking
  level, mode, fork, a host slash command — opens it through
  `Connection.openHarnessFor`, which upgrades the view IN PLACE: the
  engine-state viewer moves, a fresh `state` and `contextInfo` go out, and the
  transcript stream is NOT re-sent. Re-attaching would rebuild the transcript
  under a reader who just pressed Enter.
- The harness belongs to the SESSION; the view upgrade belongs to the
  CONNECTION. Opening one takes as long as it takes, and the reader may navigate
  meanwhile, so the two are answered separately: the command gets the driver for
  the session it was ISSUED AGAINST (`ensureViewingDriver` — a prompt typed into
  one session must never run in another), while the upgrade applies only if that
  session is still on show. Commands about the session ON SHOW (abort, model,
  thinking, mode, accept-commit, a slash command) go through
  `withViewedSession`, which opens the harness, refuses a failed open, and runs
  the command ONLY if that session is still in view — with the check and the use
  in the same synchronous step. Frames that arrive together are dispatched in
  one tick, so a `loadSession` queued behind such a command runs while it is
  suspended on ANY await, including an already-settled one; a handler that
  checked, awaited and then re-read `this.runtimeView` applied the reader's
  model choice to the session they had moved to.
- Whoever opens the harness — a queued peer message, a workflow step, another
  browser — announces it through `subscribeHarnessOpened`, so every connection
  showing that session from storage upgrades too.

What a detached `state()` cannot answer from storage it OMITS rather than
guesses: no `skillInvocations`, no `browserRuntimes`, and `canSteer: false` (a
session that is not resident is not running). The upgrade fills them in.

Two consequences worth knowing:

- Navigation is now SYNCHRONOUS. A whole class of races — "a load still
  acquiring when X happens" — cannot occur; `sessionViewRace.test.ts` pins what
  is left, which is the paths that genuinely await before they view (creating a
  session, the singleton Assistant, a delete's blocker check).
- A peer-prompt drain runs on every session open, so it checks its queue before
  acquiring anything (`peerPrompt.ts`). Acquiring first would have put the cost
  back for every session with no peer traffic — nearly all of them.

## Build only what is sent

Three rules follow from "the answer is a window, not the session":

- **Bodies only where they are read.** `SessionLog.clientTimelineForSnapshot`
  projects every row — so counts, indices and the turn-stats seed are exactly
  what they always were — but carries blocks only for the tail the reader gets
  plus any range the browser claims to hold (which has to be fingerprinted
  before a delta can answer it). Measured 144ms → 28ms on a 2,900-row session,
  230ms → 61ms on a 4,900-row one. The one consumer that reads a block from
  OUTSIDE the window is the renderability floor, which finds the entry declaring
  the window's orphan tool results; a tool loop longer than the bodied tail
  hides that entry from it, so the transport checks the OUTCOME — a window that
  renders nothing is re-projected in full — rather than trusting the tail to be
  long enough.
- **Walk in from the object you have.** A session's Tasks are resolved from that
  session's own `context` edges (`tasks.ts`'s `sessionLinkedTasks`), not by
  listing every Task and filtering. This is also why `broadcastState` got
  cheaper, which matters more often than opening does.
- **Ship what is rendered, not what it was rendered from.** The peer-prompt
  history in `SessionState` carries `peerPromptExcerpt` output — the same two
  clamped lines the collapsed Peer prompts panel draws — and no transition audit
  trail, which nothing has rendered since it was taken out of the UI. The full
  message is read where it is worth reading: the other party's transcript, which
  every bubble links to.

Together those take a cold open of the heaviest session in this data set from
2,611ms to ~210ms, and a light one to under 30ms. What is left of the cold cost
is reading and parsing the log file itself (~5ms/MB; the median session's log is
0.29 MB and the p99 is 5.35 MB); a session already resident answers in ~40ms.

## What a coordinator costs

A session that spawned siblings pays for what they SAY, not for how many there
are — the history is capped at 50 messages either way. Before the excerpt rule,
that cap meant 50 full agent briefs:

| coordinator         | `SessionState` before |  after |
| ------------------- | --------------------: | -----: |
| 20 threads, 50 msgs |                130 KB |  16 KB |
| 16 threads, 50 msgs |                149 KB |  16 KB |
| 18 threads, 50 msgs |                110 KB |  16 KB |
| no peers            |                0.6 KB | 0.6 KB |

That payload rode the session's snapshot AND every `state` broadcast it made —
turn completion, every `task_manage` result, every question/approval/card change
— to every connected browser. Building it was never the problem (~5ms); sending
it was.

## Letting go

Opening a session cheaply is half of it; the other half is not keeping it. A
resident session costs 1.2–2.3× its log's size in heap (a 5.9 MB log holds 8.7
MB), and before this nothing released a session that was only VIEWED: the
detached runtime session a reader opened stayed live until a delete, a pi
eviction or a restart, so every session looked at since boot stayed resident.
Claude SDK sessions were never released at all, and each held its committed
timeline (a 14.5 MB record parses to 46.6 MB) beside its runtime log.

**A session lives as long as its owner holds it, and each resident object has
exactly one owner.**

- A DETACHED runtime session belongs to its VIEWS. `attachRuntimeView` retains
  it (`SessionRuntime.retainView`) and detaching releases it; when the last view
  lets go, it is disposed after `VIEW_RELEASE_GRACE_MS` (60 s) unless a view has
  come back. Counts belong to the instance, so a late release from a view of a
  session since disposed and reopened cannot release the new one. A session
  `openForView` brings live without a view (a storage-backed `contextInfo`) is
  on the same clock.
- A runtime session with a HARNESS bound belongs to that harness's store. Both
  stores release an idle harness after `HARNESS_IDLE_EVICT_MS` (5 min) unviewed,
  and release its runtime session with it through `releaseHarness` — which
  leaves a detached one alone, because that one is a reader's. `disposeSession`
  is for deletes.
- A Claude SDK session is released only when nothing lives only in it: no
  viewer, no turn, no Claude process (a retained one hosts background work), no
  compaction, Stop, provider turn, queued steer, owed follow-up or naming agent,
  no live browser runtime (disposing would close it), no runtime run and no
  prompt admitted at `runtimePrompt.ts` — and only after a final persist
  SUCCEEDED, so a session whose record could not be written stays resident
  rather than lose what only memory holds. A session found busy when its clock
  runs out starts a new one rather than stopping. (The pi harness goes when
  unviewed, not running and with no prompt admitted, closing a browser runtime
  with it, as it always has.)
- A session read without being brought live — fork anchors, a fork's copy,
  edit-and-retry's prompt text, a jump target — has its log opened for the read
  and dropped again afterwards unless a runtime session owns it
  (`SessionRuntime.readLog`). A fork's parent may no longer be on show, and its
  view grace can end while the provider cuts the native transcript.

Why these graces: re-opening a view costs a log read (~5 ms/MB; 324 ms for the
largest, 30.7 MB log), and 60 s covers flipping to another session and back or a
reloading tab. A released harness costs nothing to VIEW — the view is served
from storage — so only the next command pays the reopen, and 5 min keeps a
session resident across the follow-up traffic a turn tends to draw (a peer's
reply, a queued prompt, an answer).

Nothing may be released under someone about to drive it, in either harness.
Every acquisition restarts the harness clock (`getForDrive` on both stores, used
by `hub.acquireById`, and pi's reuse of a resident session); a prompt counts
from its admission until it settles (`SessionRuntime.admitPrompt`), and both
idle releases wait it out; and an instance released anyway answers `released`
(`HarnessDriver`, so every harness must) and is refused at
`ensureRuntimeSessionWithRuntime`, before anything is bound or appended. That
failure is not hidden: each caller surfaces or retries it its own way — a peer
send retries, a queued prompt keeps its row with the error — and the next send
acquires a fresh instance. The check and the release happen in one synchronous
step, disposal unregisters before anything else, and log and record writes are
synchronous: a view or prompt arriving at any point either keeps the resident
instance or opens a new one from a complete file.

Measured with the real runtime, store and attach path against copies of
production data (heap after GC):

| scenario                                     |    before |    after |
| -------------------------------------------- | --------: | -------: |
| 7 sessions viewed and closed (69 MB of logs) | +101.3 MB | +3.4 MB¹ |
| Claude session idle 5 min (14.4 MB record)   |  +33.9 MB |  +0.1 MB |

¹ One-time warm-up of the code paths: five more open-and-release cycles stay
flat. Re-opened views and the reloaded Claude session were identical to the
originals, entry for entry.

## What the reader sees while it happens

Waiting is legible or it is a bug (`app/web/docs/loading-states.md`). The chat
surface stands its transcript down for a placeholder whenever the route names a
session that is not in view — INCLUDING the Assistant, whose route names no id,
so `chatRoutePending` waits for the persona to arrive instead of leaving the
previous session on screen with nothing saying the Assistant is opening.

## Verifying

- `app/server/src/session/viewRelease.test.ts` — the last view releases a
  detached session after the grace and not before, a view back inside it keeps
  it, a view after release shows the same transcript, a view arriving during the
  release gets a fresh session, a view of a disposed instance cannot release its
  successor, fork and edit reads of a session no longer on show leave no log
  resident, and a harness-bound session is its store's.
- `app/server/src/claudeSdk/claudeSdkEviction.test.ts` — an idle Claude session
  is released and reloads identically; never while viewed, running or admitted;
  every acquisition restarts the clock; a failed final persist (a failed legacy
  migration) keeps it resident until a later attempt succeeds; a released
  instance is refused at the prompt door.
- `app/server/src/piSdk/piIdleEviction.test.ts` — the pi idle release waits out
  an admitted prompt, an acquisition restarts its clock, and a released pi
  session is refused at the door.
- Each release is logged: `[sessions] released <id>: its last view closed` for a
  detached session and `…: its harness went idle` for either harness. The
  package's install check drives a Claude session through both and reopens it
  after each (`docs/deployment.md#bun-package`).

- `app/server/src/detachedSessionView.test.ts` — a load acquires nothing, the
  first prompt acquires exactly once and sends no second snapshot, and a harness
  opened elsewhere upgrades a reader's view.
- `app/server/src/session/transport/timelineWindow.test.ts` §9 — the snapshot
  projection is the full projection, row for row, minus bodies nobody reads.
- `app/server/src/tasks.test.ts` — the session-scoped Task lookup answers
  exactly what the whole-table list it replaced did.
- `app/server/src/peerPrompt.test.ts` and `app/shared/protocol.test.ts` — the
  history projection carries an excerpt whatever the message weighs, and the
  excerpt is flat, bounded and idempotent (so re-excerpting never adds a second
  ellipsis).
