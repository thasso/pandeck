# Shared protocol package

- No server-only or React-only imports. `pa://` helpers carry compact metadata,
  not full reads. Document targets name their source; a worktree path without
  `view=diff` means ordinary file view; shared parsing never trusts HTTP
  origins.
- Prefer additive evolution and explicit discriminated unions; keep provider
  capability flags additive so older clients can ignore them.
- A Task is the USER's object, so an agent's judgement about it stays a
  SUGGESTION with provenance and never a state the user must undo: a status
  travels as `TaskSummary.statusSuggestion` (`done` or `todo`, no third value),
  recorded INSTEAD of moving the Task there and dismissed through
  `TaskSaveRequest.clearStatusSuggestion`; an ordinary save must never silently
  discard a pending one, and one whose `to` already equals the Task's status is
  ANSWERED provenance, never a pending question. `TaskSummary.triagedAt` is the
  same shape for arrivals: unset means still in the Inbox, and
  `TaskSaveRequest.triaged` is the explicit dismiss/restore. Model every further
  agent-written Task field on that seam — `docs/tasks.md` is the contract, and
  the wire model must not grow a way for an agent to assert Task state.
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
