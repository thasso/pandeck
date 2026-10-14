<!-- instruction-budget: bytes=3950 reason="twelve dense contracts. The newest is exposure evidence: background facts were retired, or re-offered, from whether a prompt resolved or which error it threw, when only the runtime knows if the provider ever had it. Teardown before it: a store that disposed its harness before closing the runtime run lost a mid-turn outcome, and the default clean end marked stopped peer work completed." task=completion-recovery date=2026-10-14 -->

# Session subsystem

- Keep the dependency direction: adapters emit provider-normalized events,
  runtime consumes adapters and writes logs, transport reads runtime and sends
  wire envelopes, and `log/` imports none of the other three.
- Subscribe before taking snapshots wherever event ordering matters.
- Detached runtimes belong to views: attach `retainView`s, detach releases after
  grace. Bound runtimes belong to their harness store: idle eviction uses
  `releaseHarness`; `disposeSession` is for deletes. Stores call
  `closeForTeardown` BEFORE harness disposal to preserve in-flight outcomes.
- Assistant entry `usage` is ONE run's own delta, never a cumulative: harnesses
  convert their cumulative totals through `adapters/nativeEvents.ts`'s
  `perTurnUsage`, and consumers sum entries.
- Durable conversation content belongs in logs, transient streaming state in
  runtime; hidden prompts stay durable but are skipped by display projection.
- Runtime transport owns viewed-session run-state delivery; never mirror it
  elsewhere. It sends `ClientRuntimeEvent`, never `RuntimeEvent`: live bodies as
  refs, text only to a subscribed viewer (demand first, snapshot second),
  durable rows as `timelineDelta` under the snapshot's lazy policy
  (`timelinePayloadPolicy.ts`, bounding tool results by lines AND chars).
- Model-only prompt enrichment rides `RuntimePromptOptions` so the durable log
  keeps the clean human text; never wrap a prompt to inject hidden context. The
  Plan-mode hint is per-TURN enrichment, never a persisted system-prompt suffix.
  Continuations append no user row, deferred background facts, memory or Plan
  hint. Recovery reserves typed-busy admission before idle; waiters/notices
  await its final outcome. Native audit and health stay per-run.
- Steer only with `steer: true` and `canSteer`. Under `steerOnly` the DRIVER
  either steers or appends nothing, frees dedup and throws `SteerNotTakenError`;
  it never starts a turn. `steerAcceptance: "deferred"` appends only in
  synchronous `onSteerAccepted` inside that run, or a late `followUp` after the
  reply; no acceptance appends nothing and is `SessionBusyError`. Never label a
  new turn as a steer.
- `runtimePrompt.ts` is the ONE door every run passes, so session-wide safety
  invariants belong there, ahead of the runtime session and any append — never
  only at a client entry point. A gone worktree and a Stop-held turn lacking
  resume authority (`automaticTurnHold.ts`) are refused there; keep new ones
  beside them.
- A provider scan is the harness's OWN transcript, not our log: bind ONLY the
  turn that just completed, matched from the END by turn structure and call ids
  — never positionally, never the history — all-or-nothing, and fork at its
  TERMINAL native id.
- `onProviderCall` fires right before EVERY adapter `prompt`, and
  `onProviderDeclined` only on the adapter's own took-nothing answer; callers
  read exposure from these, never from a prompt's error type or resolution.
- Aborted turns are lossless everywhere: persist partial assistant content with
  `stopReason: "aborted"` and completed tool results before the aborted run
  completion, and mirror a live `toolEnd` into the transient stream so a
  reconnect does not re-open a finished tool.
