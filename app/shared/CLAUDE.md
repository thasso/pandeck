# Shared protocol package

- No server-only or React-only imports. `pa://` helpers carry compact metadata,
  not full reads. Document targets name their source; a worktree path without
  `view=diff` means ordinary file view; shared parsing never trusts HTTP
  origins.
- Prefer additive evolution and explicit discriminated unions; keep provider
  capability flags additive so older clients can ignore them.
- A Task is the USER's object, so an agent's write to it stays visible and
  reversible. An agent's `done`/`todo` is APPLIED and its claim recorded as
  `TaskSummary.statusSuggestion` (`done` or `todo`, no third value) with `to`
  equal to the status: ANSWERED provenance, never a pending question. Only an
  explicit `suggestOnly` write leaves it PENDING instead of moving the Task,
  dismissed through `TaskSaveRequest.clearStatusSuggestion`; an ordinary save
  never silently discards a pending one, and a user status change clears either.
  `TaskSummary.triagedAt` is the pending shape for arrivals: unset means still
  in the Inbox, and `TaskSaveRequest.triaged` is the explicit dismiss/restore.
  Status is the one Task field an agent sets directly; model any further
  agent-written field on the pending seam — `docs/tasks.md` is the contract.
- Integration settings projections stay minimal and secret-free.
- Viewed-chat run state belongs to runtime snapshots and events; `SessionState`
  stays session metadata and must not carry a working-indicator field.
- Keep the display projection deterministic — server reconnect snapshots and web
  reducers must render the same result — and test it HERE: it decides what the
  user sees, so its shape and object-identity guarantees belong in this package
  rather than being inferred from the server/web suites.
- A timeline window/range is bounded by entries AND bytes (entry floor over-runs
  bytes; an orphan slice's declarer, both) and starts at a turn boundary if one
  fits; a longer turn opens mid-turn: seed says `partialTurn`, the fragment gets
  no turn row.
