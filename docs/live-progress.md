# Live run progress

A running session used to show "Thinking" until its assistant turn committed,
because both harnesses hand the durable log a turn's assistant entry and tool
results in one flush at its end. A session ten minutes into a tool loop and a
session whose provider had not answered for ten minutes looked the same. Run
progress is what the runtime has observed of the run in flight, delivered while
the run is still going, so a reader can tell the two apart without opening
native logs.

## What is observed

`RunProgress` (`app/shared/session/progress.ts`) holds timestamps and counters,
never content:

- `startedAt`: when the runtime marked the run running.
- `lastActivityAt`: the latest sign of life from the provider or a tool: output,
  a response starting, stop and usage metadata, a tool starting, writing or
  finishing, a retry report.
- `lastModelOutputAt`: the latest model OUTPUT — non-empty text or thinking, a
  tool call chosen, its arguments being written. Nothing else moves it.
- `awaitingModelSince`: input went to the model at this time and no output has
  come back. Set when the run starts and when the last running tool finishes.
- `runningTools`: every tool running now, by call id and name, in start order.
  Several can run at once, and one finishing never hides another.
- `lastTool`: the latest tool transition (started, completed, failed). A tool
  counts as finished at its live `toolEnd`, not at the durable flush at the end
  of the turn.
- `retry`: the provider reported a failed request it is retrying, and has not
  answered since (a response starting or output ends it). It comes only from the
  harness: Claude's `api_retry` system message, pi's `auto_retry_start`. Both
  arrive as the transient `providerRetry` adapter event. pi's durable
  `provider.notice` transcript entry is unchanged, and Claude's transcript gains
  nothing.

Events with no delta of their own reach the runtime as the content-free
`providerActivity` adapter event, classified by the harness:

| Kind        | Claude `stream_event`                                     | pi `message_update`                | Effect                                    |
| ----------- | --------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| `output`    | `tool_use` block start, non-empty `input_json_delta`      | `toolcall_start`, `toolcall_delta` | output: ends the wait and a retry         |
| `response`  | `message_start`                                           | `start`                            | ends a retry; the wait for output goes on |
| `lifecycle` | `message_delta` (stop reason, usage), stops, other deltas | other starts and ends, `done`      | activity only                             |

A response that starts and ends with metadata alone therefore leaves the run
"Waiting for model", with the provider shown as active, and never resets the age
of earlier real output.

The phase is derived, never stored: `tool` while any tool runs, else `retrying`,
else `waiting` while `awaitingModelSince` is set, else `receiving`.

## What it does not claim

- A quiet provider is reported as quiet: "Waiting for model 12m", never stalled
  or deadlocked. No duration changes the tone of the line. Only a reported retry
  does, because it is an observed provider failure.
- No retry count is inferred. A harness that reports nothing about retries shows
  a growing wait, not a retry.
- No token activity is invented. Claude streams a request's response but not its
  sending, so `awaitingModelSince` dates from when our side handed over the
  input (the prompt, the last tool result). It does not date the request the CLI
  actually made. The same holds for pi.
- Waiting on peers or background work is shown only as the counts the queues
  hold (below), never classified from an idle run.
- Progress is runtime memory. A server restart ends every run, so a reconnect
  after one carries no progress at all, and `interruptedRun` says what happened
  (`interrupted-turns.md`).

## Lifecycle and delivery

`RunProgressTracker` (`app/server/src/session/runtime/progress.ts`) lives on
`LiveRuntimeSession` and follows its run state. `setRunning(true)` starts it and
`setRunning(false)` stops it, however the run ended (end, error, abort, a host
command). Nothing an adapter emits starts it on its own. A tool completion for a
call the current run never started (a late callback from an earlier run, or the
durable copy of a completion already reported live) changes nothing. A coalesced
publish still pending when a run ends is dropped, so nothing from an ended run
reaches the next one.

### Run ownership

Progress credits only the provider run the current running state belongs to, so
a late callback of an earlier run cannot clear a wait, report a retry or start a
tool in the current one:

- The harness numbers its runs (`run` on adapter events). The shared event
  source (`adapters/nativeEvents.ts`) opens a run with a turn's first message
  and closes it when the turn completes (its final message, `runCompleted`, a
  host-command result). A retry or a follow-up inside the turn continues it.
  Because both harnesses emit in their provider's own order, what a harness
  emits after its turn closed carries no run, whenever it reaches the runtime.
- Claude also checks where a message came from. While a turn is open, a turn
  message — stream event, assistant message, tool result, result, `api_retry` —
  from a query epoch that does not own that turn is DROPPED before it touches
  anything: a closing process still delivering after the next turn started
  writes nothing into that turn's live message or tools, its durable content,
  its native anchor, model or error, and credits no progress. Such a message
  belongs to a turn that already settled and was committed then; it is not
  re-homed into the open turn or transcribed afterwards. The rest of that
  epoch's traffic (background-task lifecycle, compaction, the process closing)
  is still handled, `unattributed` to any run. With no turn open, a provider
  message opens a provider-initiated turn on its own epoch as before, and a
  turn's own follow-ups and retries come from the epoch that owns it.
- The runtime binds its running state to the run its first message announces and
  credits nothing else: an event of another run, or of none, moves no progress.
  A run an earlier running state was bound to is never rebound, and a new
  adapter numbers afresh. Tool output and completions also count only for a tool
  this run started and that still runs.

The tracker only observes. It never prompts, resumes or wakes a session, so a
Stop's hold (`automaticTurnHold.ts`) is untouched. The idle hook fires only on
the real end of a run.

Publication goes through the runtime's ordinary feed as
`{ type: "runProgress" }`, after `runStateChanged: running`:

- A transition publishes at once: the run starting, a tool starting or
  finishing, a retry report, the first output after a wait.
- Output alone only moves a timestamp and is coalesced to one publish per
  `PROGRESS_COALESCE_MS` (2 s). A streaming model costs one small frame every
  two seconds, not one per delta. A silent provider costs nothing.
- The gateway relays it unbatched, and the snapshot carries `progress` while the
  run is live. A reconnect, a session switch and `/assistant` therefore all
  restore the current state from the snapshot, which is subscribed before it is
  taken like the rest of it.

Timestamps are the server's. `observedAt` is the server clock when the value was
published. A client ages every timestamp as `observedAt - at` plus its own time
since receipt (`runProgressAge`), so clock skew between browser and server never
shows.

## Where it is shown

- **The conversation** (`RunProgressLine`): the line under the streaming
  message, or alone under a prompt no reply has opened for yet, states the phase
  and how long it has lasted. It names the oldest running tool, the wait, the
  retry attempt and HTTP status, or thinking versus answering, with the tool
  that just finished and what waits behind the turn. The full account is its
  tooltip. While waiting, a provider that answered without output reads
  "provider active 5s ago": alive, not producing. `MessageList` provides it
  through context, so a progress frame re-renders that line and no transcript
  row. The permanent Assistant's side panel uses the same line and now reads run
  state from `runState` rather than from open streams.
- **The Sessions inbox**: a running card's detail line says "Provider is
  retrying a failed request (attempt N of M)" while
  `SessionListItem. providerRetry` is set, and nothing otherwise. The row moves
  only when a retry starts, reaches another attempt or ends
  (`sessionActivity.ts`). Tool and output transitions never rebuild the session
  list (`docs/session-list.md`).
- **Agents**: `session_lookup` and `session_read` add `liveActivity` (phase, run
  age, seconds since the last activity and model output, wait, running tools,
  last tool, provider retry) for a running session, and `queuedWork` (peer
  messages, background updates) for any session. A coordinator can check whether
  a peer is working without its transcript, whose assistant turn only lands when
  it completes. Names and seconds only: no arguments or output.

## Queued work

- Peer messages: `SessionState.queuedPeerPrompts`, which the viewed session
  already received live.
- Background updates: `SessionState.queuedBackgroundUpdates`, the count
  `BackgroundCompletionDelivery.queuedCount` holds (wake and deferred notices; a
  batch being offered or claimed is no longer counted). It is a map lookup, and
  a change reaches the session's viewers once per microtask as
  `backgroundUpdateQueue`, which also carries `unhandled`: updates a turn was
  given and did not finish (`steering-and-queueing.md`, "Delivered is not
  handled"), a separate count the progress line never adds in. While a Stop
  holds the session, the queue ledge states this count with its Resume. That is
  the place for a held session, and the progress line never stands in for it.
