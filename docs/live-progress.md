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
- `lastActivityAt`: the latest event of any kind from the provider or a tool.
- `lastModelOutputAt`: the latest model output of any kind. That includes text
  and thinking, and also a tool call's arguments being written and a response
  starting, which have no delta of their own. Harnesses report those as the
  content-free `modelActivity` adapter event: Claude for every `stream_event`
  that produced no text or thinking delta, pi for every `message_update` other
  than text, thinking and `error`.
- `awaitingModelSince`: input went to the model at this time and nothing has
  come back. Set when the run starts and when the last running tool finishes.
- `runningTools`: every tool running now, by call id and name, in start order.
  Several can run at once, and one finishing never hides another.
- `lastTool`: the latest tool transition (started, completed, failed). A tool
  counts as finished at its live `toolEnd`, not at the durable flush at the end
  of the turn.
- `retry`: the provider reported a failed request it is retrying, and the model
  has produced nothing since. It comes only from the harness: Claude's
  `api_retry` system message, pi's `auto_retry_start`. Both arrive as the
  transient `providerRetry` adapter event. pi's durable `provider.notice`
  transcript entry is unchanged, and Claude's transcript gains nothing.

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
  after one carries no progress at all, and `interruptedRun` says what happened.

## Lifecycle and delivery

`RunProgressTracker` (`app/server/src/session/runtime/progress.ts`) lives on
`LiveRuntimeSession` and follows its run state. `setRunning(true)` starts it and
`setRunning(false)` stops it, however the run ended (end, error, abort, a host
command). Nothing an adapter emits starts it on its own. A tool completion for a
call the current run never started (a late callback from an earlier run, or the
durable copy of a completion already reported live) changes nothing. A coalesced
publish still pending when a run ends is dropped, so nothing from an ended run
reaches the next one.

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
  tooltip. `MessageList` provides it through context, so a progress frame
  re-renders that line and no transcript row. The permanent Assistant's side
  panel uses the same line and now reads run state from `runState` rather than
  from open streams.
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
  batch being offered is no longer counted). It is a map lookup, and a change
  reaches the session's viewers once per microtask as `backgroundUpdateQueue`.
  While a Stop holds the session, the queue ledge states this count with its
  Resume. That is the place for a held session, and the progress line never
  stands in for it.
