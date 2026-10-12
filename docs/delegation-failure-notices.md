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

- the harness completes the turn's message with `error`, or reports the run
  ended with `error` (`messageCompleted`/`runCompleted` — pi after its own
  retries are exhausted, Claude on an error `result`);
- the adapter resolves a prompt with `error` without those events;
- the adapter throws after the prompt was appended to the log (the harness could
  not take a turn it was given).

Each is attributed to the run it belongs to, never to whichever turn is open
when it arrives. Terminal adapter events carry the provider run they close
(`run`), and the runtime ignores a completion of a run that is already over or
is not the open turn's: such a straggler neither reports a failure nor ends the
newer turn. A prompt's own late result or throw reports, and closes, only its
own run. Both harness adapters also drop an earlier run's completion instead of
answering a newer prompt with it.

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
requests were since answered, withdrawn or expired. If that changes the set
while a turn is being admitted, the turn is refused before anything is appended
and rebuilt.

## The durable boundary

The runtime calls its failure hook synchronously, once per run id, BEFORE
anything else learns of the failure: before the turn's error entry is appended
or announced (`entryAppended`), before `runStatus`, the run's closing
`run.ended` marker and any `subscribeSessionRunCompleted` listener. The hook
decides eligibility and writes the notice rows (and takes over the in-turn
requested rows) in one SQLite transaction; only then is the coordinator nudged.
A crash after that commit leaves a pending row that boot delivers.

A hook that throws — the write failed — has recorded nothing, and the runtime
does not pretend otherwise: it logs the run id and the error's class (never its
text), keeps the failure in memory, and retries it at the run's later reporting
points and at every turn boundary. Until it is recorded, every run marker the
session writes (`run.started`, `run.ended`, `run.aborted`) names it in
`unrecordedFailures`, so the NEWEST marker always lists every failure still
owed, however many turns ran since. Boot reads it back
(`recoverRunFailureNoticesOnBoot`, before peer recovery): for each working-set
session it reads the newest marker and, for every run it lists — plus the run it
opened, if the process died inside it — that run's own entries from one bounded
read (8 MiB) of the log's end. An error entry or an error `provider.notice`
there is recorded under the run's incident key, so a run already recorded writes
nothing. A crash before any failure entry exists leaves no failure to find and
announces nothing; the run is only marked interrupted, as before.

Not covered: a settled or archived child, which boot does not read; and a run
lying further back than the bound.

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

Logs on this route name sessions, runs and error classes only: a notice turn
that fails, or a failed write, never logs the provider's message.

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
- **The stand-down marker is in memory.** A restart between a coordinator's
  `stop` and the stopped turn's end is a restart, which the turn does not
  survive anyway.
- **Aborted lifecycles and a supervisor for failed completions** (retrying or
  reassigning) are out of scope.
