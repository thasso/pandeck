<!-- instruction-budget: bytes=3328 reason="eleven dense contracts. The newest is residency: a harness idle eviction that disposed its runtime session instead of releasing it would kill a reader's detached view, and a view that never released kept every session opened since boot resident (a 5.9 MB log holds 8.7 MB of heap)." task=session-eviction date=2026-09-29 -->

# Session subsystem

- Keep the dependency direction: adapters emit provider-normalized events,
  runtime consumes adapters and writes logs, transport reads runtime and sends
  wire envelopes, and `log/` imports none of the other three.
- Subscribe before taking snapshots wherever event ordering matters.
- A DETACHED runtime session belongs to its views: attach `retainView`s it and
  detach releases it after a grace. One with a harness bound belongs to that
  harness's store, whose idle eviction calls `releaseHarness`; `disposeSession`
  is for deletes and would kill a reader's detached view.
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
- Mid-turn steering is explicit (`steer: true`) and only when the driver reports
  `canSteer`. Under `steerOnly` the DRIVER decides and never falls back to
  starting a turn; a refusal appends nothing, frees the dedup key and throws
  `SteerNotTakenError`. Under `steerAcceptance: "deferred"` the runtime appends
  only in `onSteerAccepted`, which the adapter calls synchronously inside the
  run (a late one as `followUp`, after the reply); none appends nothing and is
  `SessionBusyError`. Never report a started turn as a steer.
- `runtimePrompt.ts` is the ONE door every run passes, so session-wide safety
  invariants belong there, ahead of the runtime session and any append — never
  only at a client entry point. A session whose worktree is gone is refused
  there today; keep new ones beside it.
- A provider scan is the harness's OWN transcript, not our log: bind ONLY the
  turn that just completed, matched from the END by turn structure and call ids
  — never positionally, never the history — all-or-nothing, and fork at its
  TERMINAL native id.
- Aborted turns are lossless everywhere: persist partial assistant content with
  `stopReason: "aborted"` and completed tool results before the aborted run
  completion, and mirror a live `toolEnd` into the transient stream so a
  reconnect does not re-open a finished tool.
