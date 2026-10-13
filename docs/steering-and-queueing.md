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
- **One per idle edge, the user first.** The idle chain delivers agent handoffs
  (decisions the agent may be blocked on), then this queue, then peer prompts
  and background completions. A peer drain started by any other trigger defers
  while a queued message is owed (`promptQueueHasPriority`). A send counts once
  its user entry is appended, so the drain returns before the turn ends and
  every later step sees a busy session.
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
  idle edge on (peer prompts, background completions), since a peer drain that
  deferred to it started no turn of its own. That hand-off is a `requestDrain`,
  which runs once more after a drain already in flight rather than being
  swallowed by it.
- **Commands.** A queued host slash command (`/compact`, `/commit`) is stored
  with `command` and runs through the same host-command runner when its turn
  comes, under the same worktree guard as a typed one. It leaves the queue only
  once it ran; meeting a turn that started first (`SessionBusyError`) keeps it
  for the next idle edge, and a real failure holds the queue on it. A command
  the web app runs itself (`/review`) cannot be queued; one that only touches
  session metadata (`/rename`) runs at once instead, even mid-turn.
- **Attachments** are saved to the session attachment store when queued. The row
  keeps only their metadata, and the send reads the bytes back.

The permanent Assistant has its own intake queue and does not offer this one; it
only shares the Stop hold and its Resume.

### Peer prompts in the queue

Peer prompts other sessions sent are not the user's drafts, but until delivery
they wait in the same place. The session state projects them as
`queuedPeerPrompts` (`peerPrompt.ts`, every row not yet delivered: queued,
retrying or being dispatched), re-sent as `peerPromptQueue` on every transition
of one. A row carries its sender, an excerpt, and the opaque key of the sender's
card, which the commands address it by.

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

  An answer sent before the Stop keeps the request `replied`. Each settlement is
  a compare-and-set from the admitted states, so a duplicate or late callback,
  or a straggler of an older run, never rewrites a newer outcome. Resume drains
  only rows that were never admitted. Rows completed before this distinction
  existed are not relabeled.

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
  recorded in `background_delivery_outbox` (identities only; the notice is
  rebuilt from its background-work row) and leave it once delivered or dropped
  by the bounded queue, never on a failed offer or a shutdown. A row a Stop
  touched — saved while its session was held, or owed when a Stop landed — is
  `retained`, and so is every frozen-deadline Stop's fact, whose receipt the
  store writes in the same transaction as the terminal row (nothing else would
  tell the owner its work ended, so no crash after that commit may lose it).
  Boot restores every retained row with its original wake or defer decision
  until it is delivered, held or not: a Resume authorizes delivery, it does not
  perform it, so a fact released and then cut off by the restart, refused as
  busy or unavailable, or carried by a prompt that never committed comes back. A
  session no longer held is offered its restored wake facts at boot through the
  usual peer-first drain; one still held waits for Resume; a deferred fact rides
  the next turn. Any other row is forgotten at boot, as pending delivery always
  was, so no past job is announced again. Delivery is at-least-once: a fact is
  retired only after its turn resolved (a deferred fact, after its carrying
  prompt was appended and resolved), so a restart inside an admitted turn
  delivers it again. What is guaranteed not to be lost before admission is a
  retained row: a deadline fact from its terminal commit on, any other fact from
  the moment its session is held. Not covered: an unretained fact, which boot
  forgets by design; a deadline Stop still unacknowledged at the crash, which
  never reached a terminal row, ends `lost` at boot and announces nothing; and a
  deadline receipt the database refuses, which rolls back the terminal
  transition with it, so the row stays running until the work's real end is
  reported or boot marks it `lost`. Monitor activity stays the lossy in-memory
  stream it always was.
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
