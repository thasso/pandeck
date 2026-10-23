<!-- instruction-budget: bytes=4096 reason="eleven contracts, each closing a silent failure seen in review or production: transcript membership from backend plus turn-running, a deferred fact the provider never took, a steer refusal counted as delivered, a muted monitor, a shell streamed like a monitor, a deadline Stop deferred as requested, Stop-all killing the next run, and a fact a failed or stopped turn retired." task=completion-recovery date=2026-10-14 -->

# Background work service

- No vendor SDK/harness imports. Backends enter through `backends.ts`, addressed
  by PA item id; `architecture.test.ts` guards this.
- `admitBackgroundWork` is the ONLY creation path. Requested launches answer a
  known RETRY before mutable policy, resolve Settings ONCE, check eligibility,
  and reserve item plus owner slot transactionally; enumerated denial creates NO
  row. Already-running `observed: true` work snapshots Settings, bypasses
  drain/enabled/eligibility, and adopts a free slot or records over-cap.
- Freeze `min(requested lifetime, Settings lifetime)`, deadline, generation and
  empty-host grace at admission. Edits govern later admissions only: never kill,
  evict, re-deadline, or reshape admitted work. Launch reads the row and host.
- Settings generation stays INJECTIVE. Pack the card exactly; never hash it.
- Eligibility uses scope, ownership edges and the harness/backend capability,
  never persona. Fail closed on unreadable/missing sessions. Exclusions do not
  alter foreground execution.
- `BackgroundWorkSupervisor` is the ONLY Stop authority. Reserve in the store
  and revalidate ownership before each targeted or owner-wide port effect. An
  unanswered target stays nonterminal `stop-unconfirmed`; never infer a process,
  kill siblings, or close a host because it failed.
- An owner's OWN Stop-all closes the host at its turn end only if a Stop it sent
  stayed unsettled; closing anyway kills the work started after it.
- Persist terminal facts BEFORE delivery. Activity and completion share one
  bounded lossy queue; raw output never enters row or prompt. Completion uses
  its stable PA artifact, activity a turn-scoped file. Structured detail goes in
  model-only context; render only the compact origin card. Scheduler admission
  keeps peer FIFO first. Use only `promptRuntimeSession`; wakes may steer,
  refusals yield. Exclude background execution from `hub.runningCount()`.
- Only a MONITOR streams activity; a background shell command pushes nothing and
  is awaited at its EXIT. Both capture the artifact. A monitor's unit is a LINE,
  never a clock tick; exceeding its sustained rate STOPS the item, never mutes
  it: silence reads as nothing to report.
- `deliveryPolicy.ts` is the ONE decision on how a terminal fact reaches the
  model, and stays pure. It never discards: a requested Stop and a
  `claude-query` item settling in a live turn DEFER, everything else WAKES. A
  Stop nobody requested wakes: the row's typed `stopOrigin` (`deadline`,
  `system`) from the Stop that WON, never a reason match; a deadline fact's
  outbox receipt commits WITH its terminal row, as does a retained `wake` for a
  `server-task` fact recorded in drain or ended at boot. `backend` +
  turn-running is NOT evidence the provider transcribed the fact: the Stop
  snapshot terminalizes when the notification is missing. A deferred fact rides
  the next turn's model-only context, never as its instruction. Sample
  turn-running at durability. A `wake` may join a running turn with `steerOnly`;
  a refusal is busy, never delivered.
- DELIVERED is not HANDLED. Claim a fact in the outbox before its append, bind
  it to its run once the provider took it, and retire it ONLY on that run's
  clean `RunOutcome`. A failed, stopped, cut-off or unknown attempt stays
  interrupted for the user's Recover or Dismiss: never re-offer it.
- Deployment drain uses the hub lifecycle authority: close admission before
  sampling, wait for prompted turns, allow bounded natural completion, record
  `stopped-for-deployment`, then Stop through ports. Restart resumes nothing.
