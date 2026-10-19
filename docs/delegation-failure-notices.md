# Delegation failure notices

A session that delegated work to another (spawned it, or asked it for a reply)
is usually idle while it waits. If the delegate's turn fails on a usage limit,
an expired sign-in, a provider fault, or a harness that refused the prompt, the
delegate cannot report that itself, and before this the coordinator simply
waited: one coordinator waited six hours on a child whose background-completion
turn hit a spend limit.

The server now records such a failure as a durable notice for the delegate's
**immediate** coordinator and delivers it through the peer drain. A notice is a
fact, never a permission: nothing retries the failed turn, reruns a job,
switches a runtime or credential, changes a budget, or replaces a peer.

Code: `app/server/src/delegationFailureNotice.ts` (policy and wording),
`app/server/src/db/delegationFailureNoticeStore.ts` (table
`delegation_failure_notices`, migration 0077), the runtime's failure hook in
`session/runtime/liveSession.ts`, and delivery in `peerPrompt.ts`.

## What counts as a failure

One failed **turn** of the child, as the runtime sees it:

- the harness says so with `runFailing`, which both harnesses emit BEFORE they
  tell any viewer of the failure: pi when its retries are exhausted
  (`auto_retry_end`), when its run settles failed (`agent_settled`) and when a
  prompt could not be sent (before its banner); Claude when its turn finishes
  with an error (`finishTurn`);
- the harness completes the turn's message with `error`, or reports the run
  ended with `error` (`messageCompleted`/`runCompleted`);
- the adapter resolves a prompt with `error` without those events;
- the adapter throws after the prompt was appended to the log (the harness could
  not take a turn it was given).

Each is attributed to the run it belongs to, never to whichever turn is open
when it arrives. Terminal adapter events carry the provider run they close
(`run`), and one the native event source emits with no run open is marked
`unowned`. The runtime ignores a completion of a run that is already over, of
another run than the open turn's, or of no run at all: such a straggler neither
reports a failure, nor ends or idles the newer turn — not even one whose first
message has not arrived yet. A prompt's own late result or throw reports, and
closes, only its own run; that is also how a genuine startup failure, before any
message, is reported. Both harness adapters drop an earlier run's or an unowned
completion instead of answering a newer prompt with it.

And one abandoned **delivery**: a peer prompt that reached `failed` because the
recipient could not be started or would not accept it after `RETRY_MAX_ATTEMPTS`
(a child whose harness never starts).

Not failures: provider retries in progress, a quiet turn, a turn that ends
normally, an idle or released harness, background work still running, and an
aborted turn. Also silent:

- a turn an abort was ASKED of, even when an error rides along: the runtime's
  own `abort()` marks the open turn, and pi marks a run its
  `explicitAbortRequested` ended (`abortRequested` on `runCompleted`), where the
  error is one an earlier attempt left behind. A provider-side abort nobody
  asked for (pi persists it as aborted, with the transport error) is still a
  failure, as it was before;
- a child the user stopped — its Stop hold stands while the turn ends, and the
  hold is written before the abort, so any outcome of that turn is the Stop's;
- a child its coordinator is standing down through `session_control` `stop` —
  covers the turn being stopped, cleared when the child's next turn starts;
- a delivery that was cancelled or withdrawn.

The peer rows such a turn delivered are settled the same way: an asked-for abort
records them `stopped` and owes their senders nothing
([`steering-and-queueing.md`](steering-and-queueing.md#peer-prompts-in-the-queue)).

## Who is told

Only sessions with durable evidence that they wait on this child:

| Route     | Evidence                                                                                              | Also required                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `spawn`   | the child's `spawned` edge, ownership `coordinator`                                                   | neither side settled, unless the coordinator has a request open in the child (in its turn or unanswered) |
| `request` | a peer prompt from that session the child holds as `awaiting_response` (its turn ended, no reply yet) | the failed turn was not itself a notice turn                                                             |
| delivery  | the sender of the abandoned peer prompt                                                               | it asked for a reply, or it is the spawning coordinator that still owns the child                        |

Never the grandparent or any other ancestor, never an arbitrary peer, never the
child itself. A taken-over child (`taken-over` or `unknown` ownership) has no
`spawn` route: the user owns it. Every party must be a live user-scope session:
not deleted, not archived.

A sender whose requested reply was being answered **in** the failed turn
(`admitted`/`acknowledged`, `responseRequested`) is told by this notice too
(route `request`, unless it is the spawning coordinator). In the same
transaction its rows are interrupted (`failure`, with a reason in our own words)
and marked told, so the peer interruption notice does not repeat it. If the
failure could not be recorded at once and the peer path interrupted those rows
itself meanwhile, that path's notice tells the sender and a later recording
skips it: one failure, one notice.

Eligibility is asked again when the notice is delivered: before the text is
built, and once more after the last await of the notice turn, right before the
append (`admit` in `runtimePrompt.ts`). A notice whose delegation the user ended
meanwhile is retired as dropped: either session deleted or archived, the child
taken over or no longer spawned by that coordinator, both sides settled with no
request of the coordinator still unanswered, or a `request` notice whose
requests were since answered, settled, withdrawn or expired. If that changes the
set while a turn is being admitted, the turn is refused before anything is
appended and rebuilt.

## The durable boundary

The runtime calls its failure hook synchronously, once per run id, BEFORE
anything else learns of the failure: on `runFailing` (before the harness's own
viewer broadcasts), and in any case before the turn's error entry is appended or
announced (`entryAppended`), before `runStatus`, the run's closing marker and
any `subscribeSessionRunCompleted` listener.

The hook (`recordRunFailureNotices`) first decides whether the turn owes
anything: a turn its coordinator is standing down, or one the user stopped (its
Stop hold), owes nothing, and an abort asked of the turn never reaches the hook
at all. Cancellation is classified here, live, never reconstructed later. The
provider's wording is classified into a category in memory and dropped. Then:

1. **Plan.** Who the failure is owed to is read AT the failure: the hook runs
   synchronously as the failure is seen, so every row it reads existed before it
   and nothing that arrives later can be in the plan — no clock decides this.
   The plan is whole: every owed route, each with every one of that
   coordinator's unanswered request ids, and every requested reply that was in
   the failed turn.
2. **Journal.** The safe facts — incident key, session, run, category,
   structured reset, failure time, whether the failed turn was a notice turn —
   and that plan (identities only) are appended to
   `DATA_DIR/delegation-failure-journal.jsonl` (`delegationFailureJournal.ts`),
   a file of its own beside the database.
3. **Database.** The plan's routes still owed (each coordinator still a live
   user session) are written, and the plan's in-turn requests taken over, in one
   SQLite transaction.
4. **Retire.** A `done` line retires the journal entry once the database holds
   it. The entry stays pending until that line is actually written.

Only then is the coordinator nudged. A database that refuses leaves the entry
pending, and the hook returns: the failure is durable. The retry sweep
(`sweepPeerPromptRetries`, every 15 s, a batch of at most 50, after the queue's
own retries) and boot replay what is still pending.

**A replay never reinterprets an old failure as new work.** It records only the
plan's coordinators and interrupts only the plan's in-turn requests, so a
request any session sent the child after the failure is never touched and its
sender is never told. An incident the database already holds — for anyone — is
complete: a replay of it, e.g. after its `done` line was lost, writes nothing
and only retires it. A failure with no plan — the database refused even the
reads at the failure, or a part of its plan was lost — is replayed along the
spawn edge alone (the child's coordinator, still owning it, neither side
settled): which requests the failed turn held is unknown, and rows read later
may be work that arrived after it, so no request is routed or interrupted. Such
a failure can reach a coordinator that is also told by the peer path's own
interruption notice. A coordinator whose in-turn request the peer path
interrupted meanwhile (a planned record came late) is told by that path instead.
An entry is never retired on a failed write, however many restarts the database
keeps refusing.

**Fairness.** A replay attempt the database refuses sends that failure to the
back of the line, so one that keeps failing never starves the others: every
pending failure gets an attempt before any gets a second.

**Retention.** Retired notice rows are pruned after 90 days — except those of an
incident the journal still holds: they are what tells a replay the incident was
recorded, and they stay until its `done` line is written. A journal that cannot
be read prunes nothing.

**Framing and the record bound.** Records are one per line, each preceded by a
newline, so a torn tail left by a process that died mid-append invalidates only
itself, never the record written after it. No record exceeds 64 KiB of encoded
bytes: the writer refuses a longer one rather than truncate it, and a plan of
any size is written as numbered `plan` parts that each fit, followed by the
`failed` record that commits them with their count; a failure whose parts are
not all present is read as having no plan, never a partial one. A plan read at
the failure that owed nobody is written with a count of 0 and read back as that
— known and empty, never mistaken for a plan that could not be read. The reader
measures every line in bytes before it decodes or parses it and skips a longer
one without keeping it. A torn `done` leaves its failure pending; the replay
finds it recorded and only retires it.

**Reading.** The journal is read once per process (at boot, or the first time it
is needed), in 64 KiB chunks. Only the pending facts stay in memory. A journal
that cannot be read (an I/O error, not a corrupt line) is never taken for an
empty one: the sweep and boot report it in fixed words, leave the file exactly
as it is, and go on with everything else — the peer queue's own retries run
first in the sweep and never wait on it; the next read tries again.

**Boot.** Boot records, before peer recovery, every pending failure whose plan
holds in-turn requests (peer recovery would otherwise reclassify them as a
restart's) and up to 200 more, then compacts the journal. The rest drain right
after boot in batches of 50, one batch per macrotask so connections and other
work run in between, and from the sweep after that. A large backlog therefore
never holds startup, but it takes time to drain: each recorded notice is a few
SQLite reads and one transaction.

**Size.** The file holds what is pending plus retired lines until the next
compaction: at boot, whenever nothing is pending, and in a running process once
the retired lines outnumber both 200 and what is pending, so draining a backlog
costs linear writing. While the database refuses, the file grows by one record
(or a few plan parts) per failure; there is no cap on pending failures, and
nothing pending is ever dropped. Measured on the test fixtures (CPU time, a
development machine): 10,000 pending failures of sessions that no longer exist,
with a 1 MB garbage line and torn tails, load in about 80 ms and drain (boot
share plus yielding batches) in about 1 s; 1,000 failures that are really owed —
real notices written to SQLite — take about 0.1 s at boot for the first 200 and
about 0.7 s for the other 800. A reviewer measured 10,000 really-owed failures
at about 4 ms of wall time each when all replayed synchronously; with the boot
share bounded, that work now happens after startup.

Nothing is ever read back out of a transcript, so how large or how many the
later turns are does not matter, and no historical failure is ever announced:
the journal starts empty.

Only when NEITHER the journal nor the database takes a failure does the hook
throw. The runtime then keeps the report in memory, retries it at every turn
boundary, and logs that it could not store it — naming the run, never the error.
Every such retry is the SAME failure: the hook keeps what it decided at the
failure — whether anything is owed (stand-down, Stop), the category, and the
plan or that no plan could be read — and reuses it, so a retry never re-reads
routing, holds or cancellations from what is current by then. That memory holds
only failures no store has taken yet, and is cleared once one does. The failure
is lost if the process ends first: the one case with no durable storage at all.

A crash before the hook ran leaves no failure anyone was told of; the run is
only marked interrupted, as before.

A delivery-failure notice is written inside the same transaction that marks the
peer row `failed` (`peerPromptStore.markFailed`'s `onFailed`); if the notice
cannot be written, the row does not fail either.

The table starts empty. No historical failure — `session_index`'s recorded run
failure, old peer rows — is ever turned into a notice.

## Delivery

The coordinator's peer drain (`drainRecipient`) delivers notices after its
queued peer batches, in one turn together with any peer interruption notice it
is owed, with origin `{ kind: "agent", agentId: "peer-notice" }`. Everything the
Stop hold and the queue already guarantee applies unchanged
(`steering-and-queueing.md`):

- **Held** coordinator: nothing is claimed and it is never cold-acquired. The
  row stays pending across restarts; Resume offers the idle chain, which
  delivers it.
- **Busy** coordinator: nothing joins the running turn. Its next idle edge
  delivers.
- **Cold** coordinator, not held: the drain acquires it, as it does for any owed
  peer work. Boot drains every coordinator with a pending row
  (`drainAllQueuedOnBoot`), so a Resume followed by a crash before the offer
  still delivers.

The same origin marks one more server-generated turn, the **reply reminder**
([Task-943](pa://task/943), `offerReplyReminders` in `peerPrompt.ts`): the
requests a session holds unanswered, listed in one turn. It is not part of the
peer drain and not an owed notice in the sense above — nothing is stored for it,
it never cold-acquires a session or runs at boot, and it is offered only as the
idle edge's last step (`app/server/src/idleEdge.ts`), after the peer FIFO, these
notices and background wakes, yielding to any of them that is owed when its turn
is admitted. It shares the origin so that its failure routes like a notice
turn's (below): along the spawn route only, never back to its requesters.

Logs on this route are fixed words with session and run ids: a notice turn that
fails says only which kind of failure it was (from an allowlist checked by
class, never the error's own `name`), and a refused write says only that it was
refused. No error message, name or stack is logged.

A notice row is retired (`delivered_at_ms`) from the append of its notice turn —
the moment the fact is in the coordinator's log — not after the turn finishes,
so a coordinator turn that then fails (often on the same limit) does not receive
it again and again. Delivery is at-least-once: only a crash between that log
append and the SQLite write delivers it twice. A delivered notice is never
replayed. Rows the eligibility check above rejects are retired as dropped
instead, and a deleted session's rows are dropped by the delete itself. Retired
rows are pruned after 90 days with the peer-prompt retention sweep; pending rows
never are.

## Dedup and loops

- One row per `(incident, coordinator)`: the incident is `run:<child>:<run id>`
  or `delivery:<peer prompt id>`. A duplicated completion event, a repeated hook
  call or a recovery pass writes nothing new. A completion that arrives with no
  turn open is a straggler of a closed turn and reports nothing. A later run is
  a new incident; a healthy later run implicates nothing.
- Repeated failures of one child while the coordinator is busy or held are
  delivered together as one entry ("failed N times, last at …", latest
  category).
- The notice asks for no reply, is no peer message and creates no reply
  obligation. Its turn continues the peer chain between the coordinator and the
  child, so a re-ask spends the same hop budget and a persistent failure ends at
  the hop limit.
- A failure of a notice turn is reported along the `spawn` route only. Spawn
  edges form a tree, so a shared limit that fails every level climbs to the root
  once per level and stops; request routes can form cycles (two sessions waiting
  on each other) and are not followed from a notice turn.

## What a notice says

The child's title and session id, when its turn failed (or that delivery
failed), one sentence for the category, and the coordinator's own unanswered
messages to it by send time (and Task id), never their text. Then: nothing was
retried, restarted or reassigned; decide under your own instructions, and tell
the user when unsure.

| Category         | Source                                                      |
| ---------------- | ----------------------------------------------------------- |
| `auth`           | provider kind `auth`                                        |
| `usage_limit`    | provider kind `quota` (spend, usage, billing, subscription) |
| `rate_limit`     | provider kind `rate_limit`                                  |
| `content_policy` | provider kind `content_policy`                              |
| `provider_error` | every other kind, and a harness that refused the prompt     |
| `delivery`       | an abandoned delivery the reason does not name more closely |

The kind comes from the harness as a structured field when it classified the
error (`RunFailureFacts` on `runCompleted`, from `ProviderErrorInfo`); otherwise
the error text is classified in memory by `analyzeProviderError` and dropped. No
provider message, exception, request or response body, prompt, tool argument or
output, URL, token or credential profile is stored in the table, sent in the
notice, or shown in the UI. The peer interruption notice's failure section uses
the same category sentences and no longer quotes the provider (`failure_reason`
stays on the peer rows the peer path interrupts, as before; rows this notice
interrupts carry a reason in our own words).

A reset time is stated only when the provider reported it as a structured field
(`ProviderErrorInfo.resetAt`, today Codex's quota payload via pi) and the
category is a usage or rate limit. It is checked after the seconds-to-ms
conversion (finite, positive, within the range a `Date` represents) and again
against the failure: not more than a minute before it, not more than a year
after. A reset failing any check is dropped on its own; the notice, its category
and every other fact still go out. A relative duration in prose ("resets in 3
hours") is never turned into a time, and Claude failures carry none.

## Limitations

- **Delegation without a spawn edge is tracked only while a reply is owed.** A
  session asked for a review that answered with an intermediate reply has
  `replied` the request; a later failure of its background turn reaches that
  sender only if it spawned the session. A general assignment tracker is
  separate work.
- **Settled is all-or-nothing on the spawn route.** A delegation the user
  settled (either side) is treated as put down unless the coordinator has a
  request open in the child.
- **The stand-down marker is in memory**, and so is the runtime's mark of an
  abort asked of a turn. Neither needs to outlive the process: they classify a
  failure as it happens, before anything is journaled, and boot never
  reconstructs a failure from a transcript, so a restart cannot turn a stood
  down run into a failure.
- **Journal writes are not fsynced**, like the session logs: they survive a
  process death, not an operating-system crash in the same instant.
- **A stale message of an old run** is still appended to the transcript as
  before; only its failure is not reported.
- **Aborted lifecycles and a supervisor for failed completions** (retrying or
  reassigning) are out of scope.
