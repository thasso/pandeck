<!-- instruction-budget: bytes=4096 reason="Sixteen bullets, each a distinct silent-failure mode. The newest: a resumed CLI's startup result ended the turn before its prompt ran, and every resume re-billed the restored cost-state. canUseTool: org-managed settings downgrade bypass and every pa tool call is denied with no prompt. Append-only timeline; steer follow-ups." task=peer-message-trigger date=2026-10-13 -->

# Claude SDK harness

- The official Claude CLI provisions profiles. PA never owns OAuth, calls
  undocumented auth controls, or exposes credentials. `claudeProfileEnvironment`
  scrubs inherited credential variables.
- Do not double-count output: live deltas build visible text; committed
  assistant messages carry metadata and tool openings. A synthetic assistant
  `error` is never streamed, so its text — the only wording a provider failure
  has — becomes the turn's error, not turn text.
- Keep `canUseTool` beside `bypassPermissions`: org-managed settings silently
  downgrade bypass to `default`, where only the callback approves; without it
  every `mcp__pa__*` call is denied with no prompt.
- A session keeps its initial persona. Plan refuses file-mutating natives in
  `PreToolUse` against the LIVE mode, never via `tools:`/`disallowedTools` (a
  retained process must leave Plan unrestarted) or CLI `permissionMode: "plan"`;
  it keeps `Read`, `Bash`, `Monitor`, search, `ToolSearch`, `Skill`, read-only
  app tools and `task_manage`.
- Persist the system-prompt suffix and apply it after the persona prompt once
  per process epoch: every fresh/resumed query gets it, while later turns on one
  retained query reuse that frozen epoch prompt.
- Model reconciliation accepts only recognized curated Claude model ids; a
  synthetic sentinel must never reach the configuration fallback or mutate the
  persisted selection.
- A `result`'s `modelUsage` is the RUNNING TOTAL for its `query()` epoch: totals
  REBASE onto the latest report over a base snapshotted at every `seam.query`
  site, less the transcript's saved `cost-state` a resume restores once the
  first report covers it. Summing is always wrong, magnitude never decides,
  zeroed crash reports are ignored. Never `result.usage` (one request);
  `usage.input` excludes `cacheRead` + `cacheWrite`.
- A clean `result` before the turn's uuid-stamped prompt starts (resume notices)
  never settles it; without `msg_lifecycle_v1` only a model-less one.
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
- Failover copies JSONL/subagents after the old query ends; active background
  work refuses it. The current row binding beats record metadata.
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
