<!-- instruction-budget: bytes=3712 reason="Fourteen bullets, each a distinct silent-failure mode. The newest is the append-only timeline: the store persists only entries past its log's extent, so editing a committed entry in place diverges from disk without any error. The steer rule: a queued message the turn did not fold in still runs as the next CLI turn, and an unconfirmed withdrawal may already have been read." task=claude-session-records date=2026-09-29 -->

# Claude SDK harness

- The official Claude CLI provisions profiles. PA never owns OAuth, calls
  undocumented auth controls, or exposes credentials. `claudeProfileEnvironment`
  scrubs inherited credential variables.
- Do not double-count output: live deltas build visible text; committed
  assistant messages carry metadata and tool openings. A synthetic assistant
  `error` is never streamed, so its text — the only wording a provider failure
  has — becomes the turn's error, not turn text.
- A session keeps its initial persona. Plan drops file-mutating natives from
  `tools:` onto `disallowedTools`, never uses CLI `permissionMode: "plan"`, and
  keeps `Read`, `Bash`, `Monitor`, search, `ToolSearch`, `Skill`, read-only app
  tools, and `task_manage`; other side-effecting app tools stay off.
- Persist the system-prompt suffix and apply it after the persona prompt once
  per process epoch: every fresh/resumed query gets it, while later turns on one
  retained query reuse that frozen epoch prompt.
- Model reconciliation accepts only recognized curated Claude model ids; a
  synthetic sentinel must never reach the configuration fallback or mutate the
  persisted selection.
- A `result`'s `modelUsage` is the RUNNING TOTAL for its `query()` epoch, not
  one run, so session totals REBASE onto the latest report over a base
  snapshotted where that query starts — every `seam.query` site opens an epoch,
  summing is always wrong, magnitude never decides it, and zeroed crash reports
  are ignored. Never the top-level `result.usage` (the final request's
  snapshot); `usage.input` is the uncached remainder, so an input total adds
  `cacheRead` + `cacheWrite`.
- A `result` is not proof of success: `is_error`, `api_error_status` or an
  `error*` subtype fails the turn and must reach the reader as its error.
- A restored session must rehydrate `updatedAt` from the record, or every
  restart back-dates it and corrupts list ordering and the unread check.
- Background tool refusal uses `PreToolUse` `permissionDecision: "deny"` (or
  top-level `decision: "block"`) with a bounded reason, NEVER `continue:false`:
  that ends the hook only after the tool has run.
- `session_state_changed: idle` is the only authoritative turn-over signal;
  `running` is an optional early hint, never a required turn-start contract.
- A turn's fork anchor is its LAST native uuid; PA owns transcript retention.
- The committed timeline is APPEND-ONLY: the store persists only entries past
  its log's extent (`claudeSdkRecords.ts`), so an entry edited or removed in
  place silently diverges from disk.
- Task `output_file` is untrusted. Capture only under the epoch root with
  no-follow checks; store bounded sanitized evidence/refusal metadata, never the
  vendor path or auto-injected content.
- A steer is a uuid-stamped input-queue message, taken only on its
  `command_lifecycle` start inside the turn or the result's
  `user_message_uuids`. One still queued at a clean result continues the SAME
  run (no run boundary, process kept); any other exit withdraws it, as unread
  only once the CLI confirms the drop, and Stop's interrupt or kill waits
  (bounded) for those answers.
