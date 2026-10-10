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
  message of their own or "Send next" lifts the pause.
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
  the web app runs itself (`/review`) cannot be queued.
- **Attachments** are saved to the session attachment store when queued. The row
  keeps only their metadata, and the send reads the bytes back.

The permanent Assistant has its own intake queue and does not offer this one.

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
  is marked `interrupted`, which tells a sender waiting on a reply. An idle
  session gets it as its next turn, ahead of the user's own queue, because the
  user chose it. A running turn that cannot steer offers no send-now: the row is
  delivered when the turn ends.
- Agent handoffs are not listed: they steer themselves into a turn that takes
  one and queue only behind a turn that cannot.

### Composer

While a turn runs the composer offers Steer or Queue. On a phone the resting
dock row stays live for such a turn: its field opens the composer and the mic
records into it, while Stop keeps Send's slot. Enter does what this device last
chose (`lib/busySendMode.ts`, `localStorage`) and Alt+Enter the other. A
provider that cannot steer only queues. Stop keeps its own button while a
message is being typed. The queue renders as `PromptQueueLedge` on the
composer's ledge, nearest the field it was typed in: the user's rows, then the
waiting peer prompts, each marked with its sender and offering send-now and
withdraw but no edit or move.
