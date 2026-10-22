# Steering and queueing

What happens to a message the user sends while a session's turn is running. Both
harnesses accept one; they differ in when they can say what became of it.

## Steering

A steer is handed to the running turn, which reads it at its next step. The
runtime sends one only when the driver reports `canSteer`, and every steer is
explicit (`steer: true`).

| Harness | Mechanism                                                                                                                                                                                | When the outcome is known                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| pi      | `AgentSession.steer()`; pi delivers it after the current tool calls, or after the reply, within the same agent run                                                                       | At submission: pi accepts or rejects it                         |
| Claude  | A uuid-stamped user message written into the live input queue; the CLI folds it in at the next tool step (a `queued_command` attachment) or, with no step left, runs it as the next turn | Later: when the CLI dequeues it (`steerAcceptance: "deferred"`) |

### Deferred acceptance (Claude)

The Claude CLI decides a queued message's fate only when it dequeues it, so the
runtime appends the user entry then, not at submission. The adapter reports it
through the synchronous `onSteerAccepted` callback: awaiting its answer would
resume the runtime only after the session had already committed the reply, or
ended the run, that came next.

- **Folded** — a `command_lifecycle` `started` frame for the uuid while the turn
  is open, or the uuid in that turn's `result.user_message_uuids` (the
  documented backstop; the lifecycle frames are outside the SDK's typed union).
  Recorded with `delivery: "steer"`.
- **After the reply** — the turn's `result` arrives without the uuid, so the CLI
  is already starting it as its next turn. The session commits the reply,
  records the message after it with `delivery: "followUp"`, and opens the next
  assistant message inside the SAME run: no `runCompleted`, no idle, and the
  process is kept for that turn. The model never saw it before answering, and
  the transcript says so. The run continues until the results have consumed
  every follow-up, whether the CLI batches them into one turn or runs one each;
  a result that names no consumed uuids (an older CLI) ends it.
- **Withdrawn** — the turn stopped, failed, or its process ended first. Stop
  withdraws every queued steer with `cancelAsyncMessage`, and on a retained
  process the interrupt waits for those drops to be confirmed (bounded at two
  seconds), because a plain interrupt keeps queued commands and runs them next.
  Until that interrupt is sent, nothing new enters that process — a prompt
  taking the idle edge would otherwise be the turn it interrupts. An ordinary
  process is killed only after the same answers, and ignores what the stopped
  turn still streams meanwhile. Nothing is appended and the runtime throws
  `SteerWithdrawnError`. That is a `SessionBusyError`, so a handoff falls back
  to its own queue, while the user's own send goes back to their queue, held,
  once the CLI has answered: a confirmed drop as it was, and a drop the CLI
  refused, failed or never answered with a note that Claude may already have
  read it. A Stop therefore neither loses a message nor sends it twice without
  the user deciding to. A withdrawal that loses the race only means the CLI
  starts a turn nobody admitted, which the provider-turn gate interrupts.

`steerOnly` (steer or nothing) is never offered by Claude: a message the turn
does not fold in still runs after the reply, which is the unasked-for turn that
mode forbids. Those callers get `steered: false` and use their own queue.

While a Claude skill submission waits for the CLI to confirm its command is
registered, `steer()` refuses. Compaction refuses too. The skill's context and
command must be the next inputs the CLI reads
([`docs/skills.md`](skills.md#user-invocation-from-the-composer)).

### Transcript

A user entry sent during a running turn carries `delivery`, projected to
`DisplayMessage.promptDelivery`. The transcript marks a steer where the turn
read it and a follow-up as having arrived after the reply. pi steers are marked
`steer` at submission.

## Queueing

A queued message waits for the running turn to end and is then sent as the next
turn. The queue is the user's own, server-side and per session
(`promptQueue.ts`, table `session_prompt_queue`), so every device shows and
edits the same one. Neither harness's native follow-up queue is used: the Claude
CLI's cannot be edited or reliably withdrawn, and pi's dies with its process.

- **Rows stay drafts until sent.** Until its turn a row can be edited, moved,
  removed or sent now. Once its send begins it is locked (`sending`): the text
  that reaches the model is the text read then, so an edit, move or removal from
  another device is refused and a clear keeps it. Send-now steers it into a
  running turn that takes steering, and otherwise moves it to the front and
  sends it as soon as the session is idle.
- **One per pass, the user first.** The per-session delivery scheduler offers
  handoffs, this queue, peer FIFO, peer notices, background completions, then
  eligible reply reminders. Starting a turn ends the pass at its append. A steer
  does not. See [Delivery scheduler](#delivery-scheduler).
- **Stop means stop.** Stopping a turn that has messages queued pauses the queue
  (`session_prompt_queue_pause`), so its idle edge sends nothing. Sending a
  message of their own or "Send next" lifts the pause. A Stop also holds the
  session's automatic turns; see
  [Stop holds automatic turns](#stop-holds-automatic-turns).
- **A noted row holds the queue.** A row carrying a note — a failed send, or a
  steer Claude may already have read — stops the queue at it until the user
  sends it explicitly. A message of their own lifts a Stop, never a note, since
  that would send it unasked, and "Send next" vouches for the next row only.
  Editing a noted row keeps its note: rewording it is not choosing to send it.
- **A failed send pauses too.** The row keeps its error for the user to edit,
  retry or remove, rather than being dropped. The paused queue then hands the
  idle edge on (peer prompts, background completions; never the reply reminder,
  which waits for a real idle edge), since a peer drain that deferred to it
  started no turn of its own. That hand-off is a scheduler wake, which marks
  another pass if delivery is already in flight.
- **Commands.** A queued host slash command (`/compact`, `/commit`) is stored
  with `command` and runs through the same host-command runner when its turn
  comes, under the same worktree guard as a typed one. It leaves the queue only
  once it ran; meeting a turn that started first (`SessionBusyError`) keeps it
  for the next idle edge, and a real failure holds the queue on it. A command
  the web app runs itself (`/review`) cannot be queued; one that only touches
  session metadata (`/rename`) runs at once instead, even mid-turn.
- **Attachments** are saved to the session attachment store when queued. The row
  keeps only their metadata, and the send reads the bytes back.
- **Skill commands are neither steered nor queued.** A user's `/<skill>` starts
  a new turn. Sent while a turn runs, it is refused with "/X starts a new turn;
  send it when the current one finishes." The text stays in the composer. Queued
  invocations are [Task-1023](pa://task/1023).

The permanent Assistant has its own intake queue and does not offer this one; it
only shares the Stop hold and its Resume.

### Delivery scheduler

`deliveryScheduler.ts` owns one admission gate per session. Producers call
`wake(sessionId)` without a payload. A wake during a pass marks another pass
from the top, including an arrival after a lane's read point. Wakes coalesce,
but never disappear into a pass that has already read the old state.

Each pass runs the auto-approval pre-pass before checking Stop. It executes
session-granted cards only while idle, even under Stop, and only queues their
handoffs. The lanes then run in order: handoffs, user queue, peer FIFO, peer
notices, background completions, reminders. Workflow assignments are not yet a
lane, see [Task-1054](pa://task/1054).

A lane exposes a cheap `owes(sessionId)` without opening a harness, and
`deliver(session)`. The scheduler acquires a cold session once, only when work
is owed. An optional `unavailable(sessionId, failure)` hook receives a failed
acquisition once per owed lane per pass, without another acquisition or a new
scheduler retry loop. It distinguishes a thrown acquisition error from an
unavailable or unpromptable result. Handoffs retain their retry budget and
timer; the user queue pauses its row; peer FIFO records its retry while peer
notices schedule their own retry. Background errors retain pending facts; an
unavailable driver gives up the in-memory batch without retiring its durable
outbox debt. The scheduler checks shutdown, Stop-held, released, promptable and
running state for the pass. While running, it asks only lanes whose delivery may
join a running turn, and only if the driver can steer. Today only the background
wake lane joins running turns. Deferred background facts stay inside that lane
and ride the next prompt's model-only context.

A new turn ends the pass; a steer does not. A failure before append is logged
and the next lane is offered. Each lane keeps its own table, rendering,
batching, retry, recovery and outcome interpretation. The current adapters
observe the existing append hook and fence subsequent claims in a drain. Before
a new idle admission, they await earlier admitted drains' settlement across all
lanes, including a background drain's peer phase. A fenced drain therefore
cannot consume a fresh offer or let a lower-priority lane overtake it. Running
joinable offers do not wait for the turn they may steer. This adds no debt-based
retry loop. The adapters do not implement runtime receipts, which are
[Task-1051](pa://task/1051). Private drain locks, rerun markers and cross-path
yield checks remain until [Task-1053](pa://task/1053).

Only a real idle edge, Resume or a reminder's own re-offer enables the reminder
lane, which never cold-acquires a session. Queue failures and removals wake the
scheduler without enabling reminders. Boot first prepares recovered rows, then
offers every owed session through the same scheduler, ordered within a session
and parallel across sessions. There is no boot ordering exception and no boot
reminder. Permanent-assistant intake, explicit send-now authority and direct
host-command turns retain their own admission paths.

### Peer prompts in the queue

Peer prompts other sessions sent are not the user's drafts, but until delivery
they wait in the same place. The session state projects them as
`queuedPeerPrompts` (`peerPrompt.ts`, every row not yet delivered: waiting for a
slot, queued, retrying or being dispatched), re-sent as `peerPromptQueue` on
every transition of one. A row carries its sender, an excerpt, and the opaque
key of the sender's card, which the commands address it by.

A directly spawned session whose coordinator was at its concurrency cap shows
its opening prompt as **Waiting for a slot** (`waitingForSlot`, a `held` row;
`docs/agent-workflows.md`). It starts by itself, in order, when its coordinator
has a slot. The automatic drain delivers nothing queued after it until it
starts, so a later message from any sender waits behind it unless the user sends
that one now. Withdraw cancels it like any waiting row, and what waited behind
it is then delivered as usual (so too when it is refused). **Send now** starts
it at once, past the cap and the coordinator's order, but its approval is
checked again first: one no longer allowed is refused (its row `failed`, the
coordinator told why) and the queue action fails with that reason. Starting it
restarts its reply deadline.

- **Withdraw** (`withdrawQueuedPeerPrompt`) cancels a row that has not started
  dispatching; the sender's card says `cancelled` with the reason. A row being
  dispatched is past recalling. The sender agent is not prompted about it.
- **Send now** (`sendQueuedPeerPromptNow`) claims that one row out of FIFO
  order. Into a running turn that steers, it goes as a steer and stays
  `dispatching` (shown as being sent) until the turn reads it; it then joins
  that run and completes, or is interrupted, when the run ends. The claim takes
  no lease, since a deferred steer can wait a whole tool step and a lease sweep
  would requeue it to be sent twice; boot recovery reconciles a stranded one. A
  steer withdrawn unread goes back to waiting; one the CLI may already have read
  is marked `interrupted`, which tells a sender waiting on a reply — unless a
  Stop ended that turn, which records it as stopped (below). Either way it is
  never sent again on its own: whether the turn read it is unknown, and the
  sender (or the user) decides. An idle session gets it as its next turn, ahead
  of the user's own queue, because the user chose it. A running turn that cannot
  steer offers no send-now: the row is delivered when the turn ends. Send-now
  holds the recipient's delivery authority: one arriving during an automatic
  delivery waits out that turn and goes before the drain claims its next batch,
  which resumes from the FIFO head once the send is done. A peer drain held up
  by a send-now settles only after that resumed drain (the user's queued message
  sent, or the peer FIFO drained), so a background completion waiting on it
  never takes their turn.
- **How a delivered batch settles.** Right before its turn is appended — after
  the facade's last await, so nothing changes in between — the batch passes its
  claim (`admit` → `reserveAdmission`): every member must still be `dispatching`
  under this claim's `attempts`, or NOTHING is sent. A row the lease sweep put
  back, the user withdrew, or a newer claim took fails the whole batch; the
  members still held go back to the queue with no attempt spent, and the drain
  claims afresh. Passing clears the lease, so from then on a row leaves
  `dispatching` only through its own delivery or boot recovery, which reads the
  recipient's log: never swept back, never withdrawable, never sent twice. A
  database that cannot check fails closed: nothing is sent, under the bounded
  retry. The batch is recorded admitted as the runtime appends it
  (`onUserEntry`), in one transaction; a write refused there is tried once more
  at settlement, and if that fails too the rows stay reserved for boot. Any
  other refusal before the append — a Stop at the run door (also of a steer), a
  busy session, a harness released meanwhile — likewise leaves the rows
  `dispatching`, so they go back to the queue (a Stop spends no attempt) or
  under the bounded retry; a released instance is sent nothing more. Admitted
  rows are never retried or re-queued: the prompt is in the recipient's context
  and its tools may have run. They settle from the `RunOutcome` the runtime
  records as the run's bracket closes (the run the batch opened; for a steer,
  the run it joined), never from whether the prompt resolved, since a Stop
  resolves it like a finished turn:
  - a clean end is `completed`, or `awaiting_response` when a reply was asked
    for — the turn finishing does not answer the request;
  - an abort someone ASKED for (the user's Stop, a coordinator's stand-down),
    including one that kept an earlier attempt's error, is `stopped` — unless
    the run's failure was reported before the abort, which leaves it a failure.
    A row without a requested reply is `interrupted`; a requested reply stays
    owed as `awaiting_response` with `interruptionKind: "stopped"`, so a later
    answer still correlates and clears it, the session list still counts it, it
    expires on its original deadline, and a later real failure of the recipient
    still reports it. No failure notice is sent and no `failureReason` is
    written: nothing failed. Cards, history and the peer summary carry
    `interruption: "stopped"` (`PeerPromptInterruption`) while it explains the
    state — "Stopped", or "Awaiting response" with a note that the turn was
    stopped — and drop it once the request is answered;
  - any other end — a provider failure, an abort nobody asked for, an end
    nothing reported — is `interrupted` (`failure`), which tells a sender
    waiting on a reply once (the delegation failure notice covers rows it
    records).

  A session torn down mid-turn — deleted, or its harness released — ends its
  open run the same way, as an end someone asked for, before anything stops
  observing it: its store calls `SessionRuntime.closeForTeardown` ahead of the
  harness's own dispose, and `disposeSession` does it first. Waiting prompts and
  steers are released, whatever the provider answers afterwards (a default clean
  end included) is ignored, the session takes no new prompt and its idle edge
  offers no queued work. A failure the run reported before the teardown stays a
  failure. Only a process that dies leaves a run for boot recovery, which
  records it as `restart`. A steer acceptance the provider had already queued
  when its run closed (Claude's `command_lifecycle` arriving after a teardown or
  after the run ended) appends nothing after the close: the message counts as
  possibly read — `stopped` when that close was a Stop or teardown, otherwise
  the uncertain-read notice — and is never sent again.

  A delivery the runtime never confirmed (no `onUserEntry`), whether its prompt
  threw or resolved, is reconciled before anything is retried or refunded,
  because the log's append persists the entry before its own bookkeeping (the
  session's stats row) and a producer may swallow that bookkeeping's failure:
  - a batch refused before its claim gate never reached anything: unsent;
  - a steer the provider took whose entry write then failed is delivered on the
    provider's word (`SteerEntryFailedError`), log or no log;
  - otherwise the canonical log decides, with three answers. The key found means
    delivered: its turn failed (`interrupted`, `failure`, sender told once),
    never a draft, and a new turn's run is closed — a steer leaves the run it
    joined alone. The log read without the key (or not there at all) means
    unsent, under the usual retry. A log that cannot be read proves nothing: the
    rows stay reserved, unrefunded and unwithdrawable, for a boot that can read
    it, and nothing is sent to that recipient until its log reads
    (`LOG_UNREADABLE_REASON` on the bounded retry). Boot likewise leaves a row
    it cannot reconcile `dispatching`.

  Passing the claim gate is recorded durably (`reserved_at_ms`, with the batch
  it would be delivered as), because a provider can take input before the app's
  log records it and the receipt of that may itself fail to persist. Boot
  recovery therefore asks two questions of a `dispatching` row whose key the log
  lacks: a row that never passed its gate is requeued; a reserved one may have
  reached the recipient, so it is `interrupted` (`restart`, "not sent again")
  and its sender, if it asked for a reply, is told once. The store refuses to
  requeue a reserved row whatever its caller decides. A delivery that KNOWS
  nothing was sent — a Stop at the door, a stale claim, a busy session, a
  withdrawal the provider confirmed unread — puts the row back unreserved.

  An answer sent before the Stop keeps the request `replied`. Each settlement is
  a compare-and-set from the admitted states, so a duplicate or late callback,
  or a straggler of an older run, never rewrites a newer outcome. Resume drains
  only rows that were never admitted. Rows completed before this distinction
  existed are not relabeled.

- **Reply keys.** A delivered request carries its reply key — the requester
  card's `messageKey` (`peerRequestKey`) — next to its own text, so the
  recipient can answer or settle it by `inReplyTo` from any later turn
  (`agent-workflows.md`, peer sessions lane). A batch of one names the key in
  the reply cue. A larger batch with a request in it starts every member with a
  label line, ``[1/3 · reply key `k…`]`` or `[2/3 · no reply asked]`, so each
  body sits between its own label and the next. A batch without requests keeps
  the plain shape. Labels are model-facing only: the transcript card shows the
  plain messages. The envelope's non-message overhead stays under
  `ENVELOPE_OVERHEAD_MAX` (500; five labelled requests with the longest title
  measure 471).
- **Settled.** The recipient may close a request without a message (a settle
  row): `settled` is terminal and recipient-written, carries the reason in
  `settle_reason`, and is owed by nobody. Like `replied`, it can be written
  while the request's own turn still runs, and a turn end never overwrites
  either: every settlement moves only from the admitted states.
- Agent handoffs are not listed: they steer themselves into a turn that takes
  one and queue only behind a turn that cannot.

### Stop holds automatic turns

A Stop is the user saying "stop", so nothing that was waiting may start the next
turn either (`automaticTurnHold.ts`, table `session_automatic_turn_hold`). The
hold is written before the turn is aborted, whether or not anything is waiting,
and survives a harness release, a reload and a restart. Fresh sessions start
unheld.

- **What it holds.** Every turn the user did not just ask for. That is
  everything automatic — peer prompts, interruption notices and delegation
  failure notices (`delegation-failure-notices.md`), background-work updates
  (including the Claude CLI waking itself for its own background task), approval
  outcomes, question answers and other card handoffs, a post-reload continuation
  — and the user's own OLDER work scheduled for later: drafts in this queue
  (shown paused) and the permanent Assistant's intake. Human provenance is not
  authority: a message typed before the Stop and queued is held like an agent's.
  Approvals still EXECUTE under their grants; only the turn that would tell the
  agent waits. Child sessions and background commands keep running, and deadline
  expiry is unchanged: the work stops at its frozen deadline, and the fact waits
  here for Resume like any other update.
- **Where.** `runtimePrompt.ts` refuses any turn on a held session that does not
  carry the user's resume authority for the current hold, at entry and again
  after its last await. Each drain also reads the hold before it claims a batch
  or cold-resumes a session, including a peer drain already awaiting the stopped
  turn, which checks again before its next batch, and the Assistant's intake
  loop, which checks before each item.
- **Nothing is lost or spent.** Held work stays where it was, in its order: peer
  rows queued (a batch refused between its claim and the append goes back with
  its attempt refunded), handoffs in their table, drafts in this queue, intake
  rows queued (one refused on its way goes back unspent), background updates in
  their pending batch. The refusal is a `SessionBusyError`, which every caller
  answers by waiting for a later edge rather than retrying or dropping.
- **Background facts survive a restart.** Completions owed to a session are
  recorded in `background_delivery_outbox` (identities and categories only; the
  notice is rebuilt from its background-work row). A row a Stop touched — saved
  while its session was held, or owed when a Stop landed — is `retained`, and so
  is every frozen-deadline Stop's fact, whose receipt the store writes in the
  same transaction as the terminal row (nothing else would tell the owner its
  work ended, so no crash after that commit may lose it). A server task (a
  background check watch, `pull-requests.md`) gets the same retained `wake`
  receipt, in its terminal transaction, for any end recorded during a deployment
  drain (a natural end in the grace, any Stop, the drain's own Stop) and when
  boot reconciliation ends one the previous process left: it runs in PA's
  server, nothing resumes it, and delivery is closed until the restart. Drained
  provider work stays silent across the restart. Boot restores every retained
  row that was never exposed, with its original wake or defer decision: a Resume
  authorizes delivery, it does not perform it, so a fact released and then cut
  off by the restart, or refused as busy or unavailable, comes back. A session
  no longer held is offered its restored wake facts at boot through the usual
  peer-first drain; one still held waits for Resume; a deferred fact rides the
  next turn. Any other unexposed row is forgotten at boot, as pending delivery
  always was, so no past job is announced again. Not covered: an unretained
  fact, which boot forgets by design; a deadline Stop still unacknowledged at
  the crash, which never reached a terminal row, ends `lost` at boot and
  announces nothing; and a deadline receipt the database refuses, which rolls
  back the terminal transition with it, so the row stays running until the
  work's real end is reported or boot marks it `lost`. Monitor activity stays
  the lossy in-memory stream it always was. Exposed facts follow the next
  section instead.
- **What lifts it.** The user, and only under the Stop that stood when they
  acted. Every Stop starts a new generation, also on a held session; the
  authority a message captures as it is sent names that generation, so a newer
  Stop that lands while it is admitted wins. Resume (also "Send next" on a
  queued row) lifts the hold at once and offers the whole idle chain in its
  usual order, the Assistant's intake included. A message the user sends now
  lifts it once appended as a turn of its own — for the Assistant, once a new
  intake row is stored, whether typed in the app or a Slack DM from the account
  owner (its authority read before the placeholder is posted); a refused send, a
  steer into the turn being stopped, or a redelivered message (an intake row
  already stored) lifts nothing. Send-now on a waiting peer prompt lifts it once
  it claims the row as the next turn (as a steer it lifts nothing). Words of the
  user's own handed over with review comments lift it only when delivered
  inline; queued behind held decisions they wait with them. Peer messages,
  background facts, approvals, reconnects, mounts and idle edges never lift it.
- **What the user sees.** The session's `promptQueue` carries
  `automaticTurnsHeld: true`, sent even when nothing of the user's is queued, so
  the composer ledge stays with its Resume ("Stopped"). The permanent Assistant
  shows no drafts, but `/assistant` gets the same Resume alone; it is the one
  queue command the server accepts for that session.

### Delivered is not handled

A background fact that reached the model has been DELIVERED; it has been HANDLED
only when the turn it reached ends cleanly. Until then its outbox row stays, and
a turn that fails, is stopped or is cut off leaves it for the user
(`completionDelivery.ts`, `backgroundCompletionNotices.ts`).

- **Phases.** A row is `owed` until a prompt carries it. One attempt claims the
  whole batch right before that prompt's append, after its last await: the
  facade's `admit` does it for a wake, the deferred claim for a fact riding
  another turn. The claim is `reserved`, all or nothing, a compare-and-set. A
  claim the store refuses or cannot write exposes nothing, and the fact waits as
  if the session were busy. The append binds the batch to the run it opened or
  joined (`handling`, with the run and entry ids), but only once the provider
  has taken it. An ordinary steer is written before the provider answers: its
  batch stays claimed and unbound until the runtime reports the acceptance
  (`onProviderAccepted`), and is bound only if its run is still open then. A run
  that closes first, cleanly or not, settles nothing of it; acceptance after
  that close is `unknown`, a decline gives it back. Only that run's `RunOutcome`
  settles it, and once bound nothing else does (a prompt that throws after its
  run reported a clean end relabels nothing): a clean end nobody aborted retires
  exactly the rows bound to it; an abort somebody asked for (a Stop, a
  stand-down, a teardown) makes them `interrupted` as `stopped`, and any other
  end as `failed`. The runtime decides which end came first, so a failure
  reported before a Stop stays a failure. Whether the prompt resolved or threw,
  an idle edge, output, a viewer, or another run ending cleanly settles nothing,
  and a stale, duplicate or foreign callback finds no row to move.
- **Exposure comes from the runtime, never from an error.** The runtime calls
  `onProviderCall` right before it hands the adapter any prompt, with the run
  open then, and `onProviderDeclined` only when the adapter answered that it
  took nothing: a steer-only `steered: false`, a deferred steer never sent or
  dropped unread on the provider's word, an ordinary steer the provider
  rejected. A claimed batch goes back to where it was (owed and queued in order,
  or interrupted as it was for a Recover) only when the provider never had the
  prompt or declined it. Everything else after the claim is interrupted as
  `unknown` and never offered again: a steer the provider took whose entry then
  failed to write, a deferred acceptance that arrives after its run closed (a
  teardown, a Stop), a provider that threw mid-call, and a steer whose run
  closed before the app recorded it (the entry would open another run, so which
  run read it, and how that run ended, cannot be told). An entry written and
  then failing its own bookkeeping before the provider was called is not
  exposure: the model never read it. A claim always has its receipt: a fact
  whose save was refused is recorded by the claim itself, while a row that is
  simply absent was retired and stays so. One item is one debt: a later revision
  of the terminal row (a retained host re-stamping its children) neither adds a
  row nor reopens one.
- **Settlement that cannot be written.** A binding the store refuses leaves the
  batch claimed under its attempt, which the run's outcome then settles by
  attempt. A settlement the store refuses is kept in memory as that exact
  outcome and retried at the next run end of any session, in order, so a failure
  stays first ahead of a later report of the same run, and a newer attempt's
  binding fences an older run's retry; the runtime's emitter swallows a
  listener's exception, so nothing here throws. A process that dies first leaves
  those rows claimed or bound, and boot interrupts them.
- **Restart.** No run survives a process. Boot first marks every `reserved` or
  `handling` row `interrupted` as `restart`, then restores owed rows as above.
  It runs inside the synchronous listen callback, before anything this process
  prompts. Interrupted rows outlive every later restart, retained or not, and
  are never offered on their own.
- **Recover and Dismiss.** Only the user moves an interrupted fact, and only the
  ones they were shown: the session state carries the oldest 20 as identities
  (`unhandledBackgroundBatch`: job, owed revision, the attempt it was
  interrupted in), and both commands name them. A fact interrupted after the
  user looked, a newer attempt of the same fact, or one a Recover is carrying
  matches nothing. Recover hands the matching facts to one NEW turn; Dismiss
  cancels their receipts. Dismiss is not handling: the job, its output and the
  Stop hold are untouched, and nothing records the facts as handled. Resume, a
  later turn of the user's or an agent's, an idle edge, a boot and a notice
  recover nothing. Recover is refused while the session is stopped (resume
  first; a held session is not even acquired), archived, deleted or running,
  checked again after the harness acquisition, and once more inside the facade's
  `admit`, after its last await and before the claim (the run door also rechecks
  the hold); a refusal at any of these leaves the facts interrupted under the
  attempt the user was shown, never owed. So does a Recover refused after its
  claim but before the provider had it (a runtime that became busy, a released
  harness, an entry write that failed): each row of the claim goes back to the
  attempt, run and entry it was interrupted under (kept in `prior_*` while
  claimed, migration 0082), so the user's saved Recover and Dismiss identities
  and the next Recover's earlier entry are unchanged. The rollback is fenced by
  the Recover's own attempt, so it never overwrites a newer one; a Recover the
  provider may have had is interrupted under its own attempt instead, keeping
  the earlier entry as its transcript locator. Its turn carries a bounded
  model-only reference: each task id (never cut), the revision it was owed
  under, label, state, output file, link, the earlier entry and how that attempt
  ended, and how many are left. The earlier block was model-only and may be gone
  from the provider's context, so the reference tells the agent to read each
  fact with `background_tasks` status and its output file, from the durable row
  and artifact. It never carries the original block or prompt again and reruns
  no job, tool or turn. Its claim is a compare-and-set on each fact's
  interrupted attempt, so a second Recover or a Dismiss racing it takes nothing.
  That turn's clean end retires its rows; any other end interrupts them again
  under the recovery's attempt. Nothing promises that the agent's side effects
  happen exactly once, or that the job's purpose was achieved.
- **What the user sees.** `SessionState.unhandledBackgroundUpdates` and
  `unhandledBackgroundBatch` (sent with `backgroundUpdateQueue`) put a row on
  `PromptQueueLedge`: "N background updates were given to a turn that did not
  finish", with Recover (disabled with its reason while stopped or running) and
  Dismiss; the permanent Assistant gets the same row. A recovery turn's card
  says it is one. Session inspection reports
  `queuedWork.unhandledBackgroundUpdates`. The session list carries
  `unhandledBackgroundUpdates` and `handlingBackgroundUpdates` (claimed or bound
  rows whose outcome is not recorded), and either holds settlement and automatic
  archival (`settleBlockedReason`), so the only place to recover them never
  disappears.
- **Sources stay readable.** The per-session artifact cap (80) never evicts the
  artifact being added (a background output is captured before the evidence
  naming it is recorded), the output of background work not yet terminal, or the
  output of a fact with an outbox row in any phase. Work that ended with no debt
  keeps no protection, and an abandoned capture is removed by its producer. A
  guard that cannot answer evicts nothing that time. Background-work rows have
  no retention of their own.
- **What it cannot see.** The Claude CLI injects its own `<task-notification>`
  into a running turn and may wake itself for its own task through a turn with
  no PA entry. Neither is bound to a PA receipt, so neither handles one, clean
  or failed: the delivery policy keeps deferring a `claude-query` fact that
  settled in a live turn, and PA's receipt is retired only by a later turn PA's
  own prompt reached. Whether the model acted on the CLI's own notification is
  not observable; the PA fact stays owed for the next PA turn, and is
  recoverable like any other if that turn does not finish. Logs name a category
  or an error class, never a provider message.
- **Limits.** A claim or binding cut off by a process death or power loss is
  read as `restart`, since the provider may have taken it; a Recover's claim cut
  off that way, or whose rollback write is refused, keeps the earlier entry as
  its locator but stands under the Recover's attempt, so identities the user
  saved before it no longer match and the refreshed list carries the new ones; a
  clean end whose retirement write never landed is read the same way, so the
  user may be asked to recover a fact a clean turn did handle. A wake or
  deferred block the prompt cap cannot carry whole takes the oldest updates and
  leaves the rest owed for the next turn. The cap never goes below 1,200
  characters, so a single update trimmed to its identity (task id, kind, state)
  always fits: a fact is carried by an identity the model can look up or not at
  all, never as a count, and nothing is offered when nothing fits. The bounded
  queue's overflow still drops never-exposed facts as before (oldest deferred,
  newest wake),. The table lives in one database: two servers on one data
  directory are not supported.

### Composer

While a turn runs, a message is QUEUED. The composer's one primary button is
Stop while the field is empty and Queue once something is typed; Enter queues.
Alt+Enter queues it and steers it in at once where the provider takes a steer —
it still passes through the queue, so it is seen there on its way (the web app
matches the new row by its text and sends `sendQueuedPromptNow` for it). On a
phone the resting dock row stays live for such a turn: its field opens the
composer and the mic records into it, while Stop keeps Send's slot. A surface
with no queue (the permanent Assistant) still steers directly.

The queue renders as `PromptQueueLedge` on the composer's ledge, nearest the
field it was typed in, OPEN by default and reopening for every new message. Each
row offers **Steer** (or **Send next** when no running turn takes a steer, and
always for a command) and **Remove**, and shows its send while it is under way;
a held queue (a Stop, a failed send) offers **Resume**, as does a stopped
session with nothing of the user's queued ("Stopped"). Editing and reordering
stay server operations but are not offered in the strip. Below the user's rows
come the waiting peer prompts, each marked with its sender and offering send-now
and withdraw, but no edit or move.
