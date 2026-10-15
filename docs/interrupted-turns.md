# Interrupted turns

What the app says about a turn the server process died inside, and how it knows.
The user needs one answer from it: send the message again, or just say
"continue".

## Detecting the cut

Both harnesses flush a turn's entries to the app log (`log.jsonl`) when the turn
completes. A turn killed mid-flight leaves only its opening `run.started`
bracket there. At boot, before anything is live, `markInterruptedRunsOnBoot`
(`app/server/src/sessionActivity.ts`) marks every working-set session whose log
ends on an open bracket. It skips archived and settled sessions. The mark is
`session_index.interrupted_run_at_ms` plus `interrupted_run_json`, and the next
run start clears both.

## Why the process ended

Boot cannot see why its predecessor died, so the dying process writes it down
(`app/server/src/serverExitRecord.ts`). The uncaught-exception handler writes a
`crash` with the error's message. For an unheard `error` event that is the
event's own message, not Node's "Unhandled error" wrapper. The SIGINT/SIGTERM
handler writes a `restart` when the drain starts. A drain the force timeout cuts
short never passes there again. The file is `DATA_DIR/server-exit.json`, and
boot takes it exactly once. If it is missing, the process was killed outright
(OOM, SIGKILL, power loss), and the cause stays absent.

## Whether the prompt survived

Only the harness's NATIVE history can answer, because that is what the agent
resumes from. The app log is flushed too late to show it. Through
`harnessRegistry.interruptedTurn`, each engine scans its own transcript from the
bracket's timestamp (`interruptedTurnEvidence.ts`):

- **pi** writes its transcript with the first user message and appends every
  message after. A user message at or after the bracket means the prompt was
  kept, and each later assistant message is one step. A session with no
  canonical transcript and no legacy one never reached pi, so its prompt was
  lost.
- **Claude** resumes from the CLI transcript named by the record's provider
  session id. The CLI writes the user line when the prompt is submitted, and
  each assistant message in parts that share one message id. Tool-result-only,
  `isMeta` and sidechain lines do not count. A record without a provider session
  id (a first turn cut short) resumes with no history, so its prompt was lost.

An unreadable history is unknown, never "lost". The mark is still written,
without a verdict.

## What the user sees

`SessionListItem.interruptedRun` carries
`{ at, cause?, promptKept?, modelSteps? }`. The session card shows the
Interrupted badge, then one sentence (`interruptedRunSentence` in
`app/web/src/lib/sessionInbox.ts`). The cause's detail goes in its tooltip:

- kept: "Server crashed after 2 agent steps — your message was kept; say
  "continue"";
- lost: "Server restarted before your message reached the agent — send it
  again";
- unknown: "Server crashed mid-turn — check the conversation before continuing".

A mark from before this detail existed keeps the old sentence.
