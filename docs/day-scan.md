# Daily Scanner v2 — product/architecture contract

Plan of record: KB entry `personal-assistant-daily-scanner-v2` (Task 131 epic).
Implementation: `app/server/src/dayScan/` (module ownership in
`reference/server-day-scan.md`). This document owns the cross-cutting behavior
contracts future slices must preserve.

## Pipeline

Staged: (1) deterministic collection commits all day data atomically to the KB;
(2) a metered, hash-gated minutes extraction/curation substage; (3) one bounded
synthesis run returning server-validated structured output. Collection and
synthesis are independently triggerable and retryable; synthesis failure never
loses deterministic data.

## Collection contract (implemented, phase 1)

- **Layers**: collectors emit normalized source FACTS only (stable id, occurred
  vs observed time, actor, links, compact source-native fields, semantics tags).
  Correlation/classification/salience are separate layers; collectors never
  pre-group or narrate.
- **Disposition vs result**: per source per run, `attempted` or `skipped`
  (disabled/unconfigured/intentionally-skipped/deferred) is orthogonal to
  `complete`/`partial`/`failed`. Skipped is never failed; the health header
  renders both.
- **Deltas**: positives (`added`/`changed`) compare against the previous
  snapshot over a volatile-field-free projection; `noLongerObserved` requires
  complete current + complete baseline and is still never narrated as removal;
  `confirmedDeleted` requires source-affirmed evidence (a bare 404/410 is
  `unavailable`, it can mean lost permissions); `failed` retains prior state and
  produces no deltas. GitHub events are a cumulative union by event id — merge,
  never replace.
- **Atomic run commit**: one KB commit per run under actor `day-scan` carrying
  `assets/manifest.json`, per-source `assets/sources/<key>.json` (+
  `.baseline.json` on complete runs), and `assets/deltas.json` under
  `daily-summaries/<date>/`.
- **Self-exclusion**: everything the scanner produces is origin-tagged (KB actor
  names `day-scan`/`day-synthesis`, Task status actor `system:day-scan`,
  scanner-created Task marker link). The PA collector excludes it; user progress
  on scanner-created Tasks counts, backed by durable Task status provenance
  (`task_status_events`, migration 0021). Historical collection includes
  archived Tasks for creation/suggestion identity, and processed meeting-day
  source trees keep links to archived Tasks; current-work signals such as due
  items remain limited to the live Backlog.
- **Per-source semantics** (digest constraints): Jira `updated` JQL is CURRENT
  state — only changelog-backed `transition` facts may be narrated as movement,
  with three-level completeness (JQL result set, selection cap, per-issue
  pagination; any truncation ⇒ partial). GitHub notifications are attention
  state — disappearance never means completed work. Calendar keeps distinct
  response states; presence ≠ attendance, and neither is acceptance: a meeting
  becomes ATTENDED only on a participant-session match for the configured user
  (Meet) or a huddle they joined, so an accepted invitation whose conference ran
  without them is calendar-only — never own work, never a logged duration, and
  its conference duration and attendee list are never presented as theirs.
  Overlapping confirmed attendance is conflict evidence, not proof of absence.
  The session requirement binds only where sessions can EXIST (a Google Meet
  conference): a meeting held in person or over another provider still derives
  from the accepted slot, marked as resting on calendar acceptance alone. Tempo
  worklog dates are claimed work dates. PA `updatedAt` is "touched", not
  "changed". Jira sprints (`jira-sprints`) are the ACTIVE sprint state (goal +
  window), not change. GitHub releases (`github-releases`) are delivery EVENTS
  (releases, deployments) plus failed CI runs (attention) across recently-pushed
  repos, bounded per repo; a per-repo fetch error is `partial`, never "no
  release". Slack (`slack`) is NARROW and privacy-gated (Task 140): mentions,
  own-authored messages, and saved items only, via `search.messages`/
  `stars.list` — never channel archives — and only metadata (channel/permalink/
  ts/kind) is committed; message body text is never committed. Email (`email`)
  is NARROW and privacy-gated (Task 141): sent mail, starred/action-needed, and
  meeting follow-ups via targeted Gmail search + `format=metadata` header reads
  — never raw mailbox ingestion; only subject + one counterparty + a permalink
  are committed, never bodies.
- **Privacy hybrid**: committed = normalized facts/aggregates/links/
  completeness/deltas. Raw payloads, bodies (including Slack/email message
  text), participant lists, others' worklog descriptions live only in the
  non-Git `DATA_DIR/day-scan-cache` (TTL 14d, 1 GB/128 MB caps, 0700/0600,
  oldest-first eviction). No per-person hours reports or contributor rankings
  anywhere.
- **Operations**: per-day lock with at-most-one coalesced follow-up; independent
  per-source failure isolation; graceful shutdown starts no new runs;
  `CalendarDayState.run` exposes the last manifest as the health header.

## Entry conventions

Day entry id `daily-summary-<date>` at `daily-summaries/<date>/`; run assets
live in that entry's `assets/` folder. Curated meetings live at
`meetings/<date>-<slug>-<short-source-id>` with a stable `kb.id` derived from
the source id.

## Correlation, classification, salience (phase 2)

- **Correlation** joins GitHub refs and Tempo worklogs to Jira issues by issue
  key and resolves the user's own identities; cross-source-corroborated issue
  keys are flagged.
- **Classification** precedence: KB override → registry primary/related Jira →
  registry git/`repoUrl` → registry fallback/historical (weak) → heuristic
  `jira:`/`repo:` bucket → explicit `unmapped`; every classification carries
  source + confidence. The mapping-inputs hash is recorded as `mappingVersion`
  in the manifest and participates in the minutes cache key; historical
  summaries are never rewritten when it changes.
- **Salience** suppresses bots + routine churn and scores
  transitions/reviews/releases/due/own/corroboration, emitting the per-project
  `assets/rollup.json`. The machine appendix (day-entry data region) is slim:
  coverage/counts/compact evidence, never a duplicate of all facts.

## Minutes curation (phase 3)

- **Composite cache key** = content hash + extractor + curator + mapping
  versions; a hit skips reprocessing ONLY when all match, a durable KB commit
  exists, and the entry is present. Explicit force-recuration overrides it.
- **Candidate identity** is stable (`source id + canonical action key`);
  re-curation reconciles (matched keep id/Task/status, dropped → `superseded`,
  new → `proposed`). Task dedup is candidate-level, not URL-level.
- **Task policy**: under the `auto` setting, HIGH and MEDIUM candidates
  auto-create Tasks; only LOW requires explicit user acceptance (the `review`
  setting requires acceptance for everything). Enforced in both the minutes
  substage (`shouldAutoCreateTask`) and synthesis apply (a low candidate is
  never created from the model's accept flag).
- Bounded concurrency + deferred continuation past `maxMinutesDocsPerRun`.
  Meeting entries carry generated + user-owned (`## Notes`) regions and anchor
  to the MEETING day, not the observation day. Extraction reads the FULL
  minutes/transcript (not keyword snippets) with a deeper-thinking model, and
  the full (bounded) text is stored durably as the entry-local
  `assets/minutes.md` and linked from the generated region. The non-Git ledger
  index carries the candidate→Task map + KB commit id so a crash between Task
  creation and the atomic commit resumes without duplicate Tasks. The live
  Google adapter is `minutesPipeline.ts` (skipped when Google is unconfigured).

## Synthesis (phase 4)

- The `DaySynthesisRunner` reasons over a bounded, claim-disciplined DIGEST of
  committed facts with a READ-ONLY tool allowlist (`kb_read_asset` only) and
  MUST return a structured result (section-id whitelist, length/count caps, link
  allowlist = `pa://` + configured hosts). Source-derived text is untrusted;
  malformed output is rejected and retryable — nothing applies.
- **Application protocol** (journaled, idempotent across KB Git + SQLite):
  PREFLIGHT revision-sensitive proposals (candidate state, thread revision)
  before any irreversible effect → journal `applying` → idempotent Task creation
  under a UNIQUE candidate→Task mapping → ONE run-id-tagged KB commit (narrative
  region, threads store + projection, candidate statuses) → `applied`. Re-apply
  RESUMES (found Tasks/commit), and startup reconciliation closes runs whose
  commit landed but journal stalled.
- **Threads** live in a structured store (`references/ongoing-threads`);
  validated proposals apply idempotently and a stale `baseRevision` is rejected.
- **Day-chat honest contract**: the day session keeps the ordinary toolset; what
  is enforced is a server-side guard (`pathGuard.ts`) in the KB commit
  validation hook — ordinary agent/user commits cannot write day-scan assets or
  alter a day/meeting entry's generated region; only `day-scan`/`day-synthesis`
  actors may. Revisions route through the runner/apply channel.

## Presentation (phase 5)

Attention-first day panel, all stats sourced from the manifest via
`CalendarDayState` (never markdown parsing): a disposition-aware data-health
header (`N/M fresh · K skipped`, changes + tasks badges, collapsed per-source +
minutes breakdown), the server-synthesized report (machine region stripped, user
`## Notes` kept), then the legacy source tree.

## Tempo logging assistant (phase 6)

- **Structured state, serialized transitions** (`db/tempoPlanStore.ts`): the row
  id is the Tempo `clientId`; status-guarded UPDATEs mean exactly one transition
  wins (`pending-approval → executing → executed/partial/failed` vs
  `→ cancelled`), and cancellation is refused once `executing`. Durable linkage
  (proposal/result ids + `resultWorklogId`) lives on the row; re-runs preserve
  `user-edited`/`dropped`/in-flight rows.
- **Derivation** is deterministic + model-free (`tempoDerive.ts`): accepted,
  timed calendar meetings mapped to a Jira issue via the learned
  `references/tempo-logging-profile` become proposals; declined/tentative/
  needs-action never auto-propose, and time already covered by a personal
  worklog is skipped. An empty profile proposes nothing (safe).
- **Approval** (`tempoApprove.ts`) drives the state machine + the real Tempo
  write (reusing the agent tool's validation/write), then learns the meeting →
  issue mapping from the confirmation. `clientId`/worklog-id reconciliation is
  deterministic (field-tuple fallback); Tempo stays source of truth next run.
- **Decline** (Task 144) is the user's deliberate "don't log this" — a
  first-class terminal `declined` transition (`db` `declineProposal`) distinct
  from a proactive `cancelled` (invalidation of a dropped/superseded row). The
  approval card's dismiss control declines; both terminal states are hidden from
  the panel projection and never re-proposed by a re-run. Like cancel, decline
  is refused once `executing`.

## Scheduled morning collection (phase 8)

- `dayScan.schedule` settings (`enabled`, `time` `HH:MM` in the profile timezone
  — `user-profile.md` — and `synthesize`) drive an automatic daily run so the
  prep view is ready before the day starts. All day-scan settings — identities,
  task-proposal policy, the caps, and this schedule — are user-editable in
  **Settings → Day scanner** (`SettingsPage.tsx` `DayScanSection`).
  `dayScan/schedule.ts` is a single self-rescheduling timer: at the configured
  local time it runs `runDayCollection` (and `runDaySynthesis` when
  `synthesize`) for the current local date, then reschedules for the next day.
- It adds only a TRIGGER — it reuses the manual scan's `runDayCollection` entry
  point, so the per-day lock/coalescing and idempotent commit protect against
  overlap with a user-initiated refresh. Started at boot, reconciled on a
  settings change, and stopped (timer cleared, no new runs) on graceful
  shutdown. DST-correct: the fire time is a wall-clock local time, not a fixed
  UTC offset.
