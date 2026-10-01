# Daily scanner implementation — reference

Relocated from `app/server/src/dayScan/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Deterministic daily-scanner domain (Daily Scanner v2): per-day collection of
source facts into atomic KB commits, delta computation, and the day read-model
behind `/api/calendar/day`. Cross-cutting product contract: `docs/day-scan.md`;
plan of record: KB entry `personal-assistant-daily-scanner-v2`.

## Module ownership

- `types.ts` owns the day-scan vocabulary: source keys, the orthogonal
  disposition (`attempted`/`skipped`+reason) vs result
  (`complete`/`partial`/`failed`) contract, `DaySourceFact`/`DaySourceSnapshot`
  shapes, manifest/delta types, the schema version, and the KB actor names
  (`day-scan`, `day-synthesis`) used for origin tagging/self-exclusion.
- `dayWindow.ts` owns DST-correct user-local day windows (default zone
  `userTimeZone()`) (`localDayWindow`, `inWindow`) plus the shared local-time
  helpers the scheduler uses: `localDateForInstant` (the local calendar date an
  instant falls on), `localWallTimeMs` (first UTC instant a local `HH:MM` on a
  date is reached), and `nextDate` — zone-defaulting wrappers over
  `@assistant/shared/zonedTime`.
- `schedule.ts` owns the scheduled morning collection (plan phase 8): a single
  self-rescheduling `setTimeout` that, when `dayScan.schedule.enabled`, fires at
  the configured `time` in the profile timezone and runs `runDayCollection` (and
  `runDaySynthesis` when `synthesize`) for the current local date — reusing the
  manual scan's per-day lock/coalescing so a scheduled run and a user refresh
  never conflict. `nextScheduledRunMs` is the pure next-fire computation.
  `startDayScanSchedule` (boot), `reconcileDayScanSchedule` (on a day-scan
  settings change), and `stopDayScanSchedule` (graceful shutdown) are wired in
  `../index.ts`/`../connection.ts`. Settings default/normalization live in
  `../settings.ts` (`normalizeDayScanSchedule`).
- `cache.ts` owns the non-Git short-lived raw-payload cache under
  `DATA_DIR/day-scan-cache` (TTL 14d, 1 GB global / 128 MB per-day caps,
  owner-only permissions, oldest-first eviction).
- `deltas.ts` owns the delta contract: volatile-field-free comparable
  projection; positives vs the previous snapshot; `noLongerObserved` only for
  complete-vs-complete-baseline; `confirmedDeleted` only from collector-affirmed
  evidence — absence is never narrated as removal.
- `correlate.ts` owns layer 2 (correlation/enrichment): joins GitHub refs and
  Tempo worklogs to Jira issues via issue keys (native `issueKey`, `jira:` fact
  ids, and keys extracted from branch refs/titles), resolves own-identity from
  `DayScanIdentities` (or a collector `own` tag), and flags cross-source
  corroborated issue keys. Pure over collected facts — no fetching.
- `classify.ts` owns layer 3 (project classification): the deterministic
  precedence KB override → registry primary/related Jira → registry `repoUrl` →
  registry fallback/historical (weak) → heuristic `jira:`/`repo:` bucket →
  explicit `unmapped`, each carrying source + confidence + secondary dimensions.
  `buildMappingIndex` composes the registry with the optional KB overlay asset
  (`MAPPING_OVERLAY_ASSET`) and derives the `mappingVersion` hash recorded in
  the manifest; historical summaries are never rewritten when it changes.
- `salience.ts` owns layer 4 (salience → rollup): deterministic scoring
  (transitions/reviews/releases/due/own/corroboration up), bot + routine-churn
  suppression, and the per-bucket `DayRollup` (capped top items) committed as
  `assets/rollup.json`. OWN work is weighted ABOVE a lone inbound-attention
  signal (own +5 vs review-requested +4 / action-needed +3) so "what I did" is
  not buried under "what landed in my inbox" in the per-bucket top-items cut.
  Each `RollupItem` carries its per-item `own` flag (not just a bucket count).
- `minutes.ts` owns the PURE minutes-curation core (plan § minutes): the
  composite cache key (content hash + extractor + curator + mapping versions)
  with `cacheKeyMatches`, stable candidate identity (`sourceId` + canonical
  action key) and `reconcileCandidates` (matched keep id/Task/status, dropped →
  `superseded`, new → `proposed`), the `shouldAutoCreateTask` policy, and
  collision-safe meeting-entry ids/paths
  (`meetings/<meeting-day>-<slug>-<source suffix>`, meeting-day anchored) +
  generated/user-owned region rendering (which links the full-minutes asset
  `MEETING_FULL_MINUTES_ASSET` = `assets/minutes.md`, written durably by the
  curation run). No I/O.
- `minutesRun.ts` owns the curation orchestrator + non-Git ledger INDEX
  (`DATA_DIR/day-scan/minutes-index.json`): composite-cache-key gating with
  force-recuration, bounded-concurrency extraction with deferred continuation
  past `maxMinutesDocsPerRun`, candidate reconciliation against committed KB,
  policy-driven Task creation with candidate-id dedup that survives a crash
  between Task creation and the atomic commit (the ledger records
  `taskIdByCandidate` and `kbCommit`; a hit requires a matching key, a durable
  commit, and an existing entry). `curateMinutes` returns staged KB writes to
  FOLD into the run's one atomic commit plus a `finalize(commit)` that stamps
  the commit id. `MinutesPipeline`/`setMinutesPipelineFactory`/
  `resolveMinutesPipeline` are the injection seam for the live Google
  discovery/extraction adapter (kept out of the deterministic core; a
  null/unconfigured factory skips the substage). The extractor + Task creation
  are the only metered/model-token part of collection.
- `minutesPipeline.ts` owns the LIVE minutes adapter behind that seam
  (`installMinutesPipeline`, wired at boot in `../index.ts`; resolves null when
  Google is unconfigured). It reuses the agent-tool cores —
  `gatherMeetingMinutesCandidates` + `loadMinutesSource` +
  `extractMinutesActions` (exported from `../tools/google/*`) — to discover the
  day's docs, fetch each source once (for the content-hash cache key), run the
  metered scanner sub-agent, and create origin-tagged Tasks. Meeting-day
  anchoring uses the candidate's user-local date; late arrivals are flagged.
- `appendix.ts` owns the slim server-rendered machine data region
  (`<!-- day-scan:data:* -->` markers: source health, changes, activity by
  project) rendered as compact LISTS (not wide Markdown tables) so it stays
  readable on mobile, the brand-new day-entry skeleton (valid frontmatter +
  empty narrative + data region + user-owned `## Notes`), and
  `applyMachineRegion`, which rewrites ONLY the marked region and never touches
  narrative or Notes.
- `collectors/` own the per-source layer-1 fact collectors (calendar, jira,
  jiraSprints, githubEvents, githubNotifications, githubReleases, tempo, pa),
  each declaring readiness, per-source semantics tags, completeness detail, and
  privacy filtering. GitHub events accumulate (union by event id). The
  `calendar` collector is a faithful listing of scheduled events only (no
  attendance). `meet-attendance` (`collectors/meetAttendance.ts`, Task 173) is a
  SEPARATE source that captures ACTUAL Meet attendance for EVERY conference the
  user was in — calendar-linked OR ad-hoc (e.g. a Slack-shared link with no
  event) — via `findMyMeetAttendanceForDay`/`getMeetSelfIdentity` in
  `../googleWorkspaceLinking.ts`: `conferenceRecords.list` over the day window
  (no meeting code) returns the day's conferences; each fact records WHO
  attended and how long (`meetParticipants` = display name + present seconds,
  from `participantPresence` — a participant's sessions are UNIONED so a second
  device never double-counts), self-matches the connected user via People
  id/display name (needs the `userinfo.profile` scope — granted after a Google
  reconnect), and correlates the meeting code to a calendar event for a nice
  title (else a participant-derived "Meet call with …"). A Meet link with NO
  code in it (`meet.google.com/lookup/<name>`, `g.co/meet/<nickname>`) is
  collected as a `CodelessMeetSlot` and correlated by TIME instead —
  `titlesByTimeCorrelation`, one-to-one and only when unambiguous, so a title is
  never guessed between two candidates and the digest does not double-list such
  a meeting. ATTENDANCE REQUIRES MY PARTICIPANT SESSION (Task 224):
  `buildMeetAttendanceFacts` (pure, tested) tags `own`/`attended` with
  `attendedSeconds` = my own present time ONLY for
  `attendanceBasis: "self-matched"`. A listed record without a session of mine
  is committed as `["meet", "unconfirmed-attendance"]` with
  `attendanceConfirmed: false`, `attendedSeconds: null`, the conference's own
  `conferenceSeconds`, a participant COUNT instead of names (the attendee
  carve-out covers my own meetings only), the reason
  (`unconfirmed-no-self-session` / `-identity-unavailable` /
  `-participants-unavailable`) and `conflictingSelfAttendance` — confirmed
  attendance of mine overlapping the slot, which is conflict evidence and never
  decides absence alone. An unresolvable identity (no profile scope) makes the
  run `partial`, as does a missing Meet scope / transient error (never blocks
  the day). `slack-huddles` (`collectors/slackHuddles.ts`) is a SEPARATE source:
  EVERY huddle from the connected user's own day history (so they always
  surface), tagged `own`/`attended` only for the ones I joined, and — the key
  context for what a huddle was ABOUT (e.g. a 1:1 with a report → people
  management) — WHO ELSE was there: participant DISPLAY NAMES resolved via
  personal OAuth (`users.info`, bounded) + status, channel id, timing, and my
  duration; never message content. Reuses `collectOwnHuddleAttendanceForDay`
  from `../tools/slack/slackHuddleTools.ts`. It is only READY when the
  experimental browser-session capability is enabled/configured and degrades to
  `partial` on a fetch failure. Both feed their `own`/`attended` facts — and
  only those — into `myWork`, the `attendance` digest slice (who + duration),
  and a `tempoDerive` duration; unconfirmed conferences feed
  `unconfirmedAttendance` instead. `collectors/githubLinks.ts` (tested) derives
  the MOST SPECIFIC canonical GitHub link for a fact — the
  PR/issue/review/comment/release html_url, a commit/branch URL for
  pushes/creates, a subject→html URL for notifications — falling back to the
  repo URL only when nothing more specific exists (so a day report link lands on
  the issue/PR, not the whole repo). `jiraSprints` (key `jira-sprints`) emits
  one fact per ACTIVE scrum sprint (goal + window, tags
  `sprint-goal`/`attention`) via the Agile REST API — no per-person data.
  `githubReleases` (key `github-releases`) emits releases + deployments
  (delivery EVENTS) and failed CI workflow runs (attention signals) across the
  org's most recently pushed repos, bounded to `MAX_REPOS` with small per-repo
  pages; a per-repo fetch error makes the source `partial` (absence is never
  narrated as "no release"). Their pure fact builders (`sprintFact`,
  `releaseFact`/`deploymentFact`/`ciFailureFact`) are unit-tested in
  `collectors/signals.test.ts`. `slack` (key `slack`) collects NARROW,
  privacy-gated signals only — mentions, own-authored messages, and saved items
  via `search.messages` + `stars.list` (never channel archives) — and commits
  ONLY metadata (channel id/name, permalink, ts, kind); message BODY text is
  never committed (treated like meeting/email body), enforced by
  `collectors/slack.test.ts`. Uses `getSlackDaySignalConfig()` (non-throwing
  readiness). `email` (key `email`) collects narrow, privacy-gated Gmail signals
  — sent mail, starred/action-needed, meeting follow-ups — via targeted
  `messages.list` queries and `format=metadata` header reads (NEVER raw mailbox
  bodies); commits only subject + one counterparty + a Gmail permalink, enforced
  by `collectors/email.test.ts`. `salience.ts` scores the new kinds
  (`ci-failure`, `deployment`, `release`, `sprint`) and tags (`mention`,
  `saved`, `action-needed`, `follow-up`, `starred`). The PA collector excludes
  day-scan/day-synthesis KB commits, `system:day-scan*` task status events,
  scanner-created Tasks' creation facts (`DAY_SCAN_TASK_MARKER`), and the day
  session (self-exclusion); user progress on scanner Tasks stays included via
  Task status provenance (`taskStore` status events). Its historical identity
  pass includes archived Tasks so a backfill still emits creation/suggestion
  facts after Backlog retention, while due-item signals explicitly require an
  unarchived Task.
- `collectionRun.ts` owns the orchestrator: per-day lock with at-most-one
  coalesced follow-up run, independent per-source failure isolation (failed
  source → last snapshot retained, no delta), baseline maintenance
  (`<key>.baseline.json` updated only on complete runs), the layer 2–4 pass
  (`correlate` → `classify` → `buildRollup`), the metered minutes-curation
  substage (`curateMinutes` via the resolved `MinutesPipeline`, best-effort: a
  discovery/extraction failure never blocks collection), the ONE atomic KB
  commit per run (manifest + snapshots + deltas + rollup + day-entry
  skeleton/data region + meeting entries, actor `day-scan`) with the minutes
  ledger finalized to the commit id afterwards, and the graceful-shutdown gate
  (`stopDayCollection`, wired in `../index.ts`). Failed/not-ready sources still
  feed last-good facts into the rollup so classification stays stable across a
  transient outage.
- `dayState.ts` owns the `/api/calendar/day` read-model (`getDayState`), entry
  id/path conventions (`daily-summary-<date>`, `daily-summaries/<date>`), the
  manifest → `CalendarDayRunHealth` wire projection, and the Tempo-row
  projection. Processed meeting-source trees resolve Task links against archived
  rows too: they are durable historical links, not a live-work list. (The legacy
  agent-driven `buildDayScanPrompt` was removed in phase 4 — the scan itself is
  the deterministic server-side collection + synthesis pipeline.) A scan mints +
  binds a watchable `assistant` day chat session (Task 162), and SYNTHESIS IS
  FOLDED INTO IT: `runDayScanWithProgress` prompts the bound session ONCE with
  `renderDayBriefingPrompt` (built from the committed digest), captures the
  turn's Markdown via `promptRuntimeSessionAndCaptureText`, and writes it as the
  durable day report through `synthesisApply.writeDayBriefingNarrative` (the
  `day-synthesis` actor, narrative region only). So one visible session both
  produces the report and is resumable for follow-ups. Headless scans (no
  session) — and the session path when the turn yields no text — fall back to
  the structured one-shot `runDaySynthesis` (which also keeps
  threads/task-proposals); the scheduled run and the `/synthesize` endpoint
  still use that structured path. NOTE: an UNPROMPTED day session is a
  non-resumable ghost (never persisted/listed), so every bound session MUST get
  a turn — even a no-commit scan prompts it. `resolveDaySessionId` reports the
  bound day-chat session id and is RESILIENT (Task 171): it clears a binding
  ONLY when the session is definitively deleted (never on a plain
  `sessionStore.get` miss — a resumable pi session read before boot-time
  metadata repair is not a ghost), and it SELF-HEALS a lost binding by finding
  the `Calendar · <date>` titled session and rebinding it, so the panel can
  always reopen the day chat. The title convention lives in
  `../calendarDaySessions.ts` (`daySessionTitle`). `renderLogMyTimePrompt` is
  driven by `connection.ts`'s `calendarDayActivate` `logTime` path, which
  ensures/prefers the bound day session and prompts it with the own-work seed.
- `synthesisSchema.ts` owns the REQUIRED structured synthesis result contract
  (Decision #1): the section-id whitelist + presentation titles, task/thread
  proposal shapes, and `validateSynthesisResult` (section whitelist, length/
  count caps). Links are NOT host-restricted — the collectors/digest hand the
  runner trusted canonical URLs (Jira/GitHub/Google Calendar/Slack/…) and the
  day report links them freely; the Markdown renderer sanitizes unsafe schemes.
  Malformed output is rejected/retryable; nothing applies. `renderNarrative` is
  the server-owned section template.
- `scanProgress.ts` owns the live day-scan workflow progress (Task 162): a
  transient per-date step model (`collect` → `minutes` → `synthesize`) with a
  broadcaster seam (installed by the hub, like `taskEvents`) that emits
  `calendarDayScanProgress` to all clients as `connection.ts`'s
  `runDayScanWithProgress` drives the deterministic pipeline. Never persisted —
  the committed manifest read via `/api/calendar/day` stays source of truth. A
  settled run's snapshot lingers ~60s for late refetches, then drops.
- `threads.ts` owns the ongoing-threads structured store (entry-local
  `references/ongoing-threads/assets/threads.json`, Markdown is a projection):
  stable ids, lifecycle states, merge/dedup by issue key, a monotonic revision,
  and revision-idempotent `applyThreadProposals` (stale `baseRevision` rejects a
  proposal; applying bumps the revision once so re-proposing the same base is a
  no-op).
- `digest.ts` owns the claim-disciplined synthesis INPUT:
  `buildDaySynthesisDigest` assembles health/rollup/deltas/open
  candidates/threads-revision AND the linkable references (curated `meetings`,
  scan-`createdTasks`, `jiraBaseUrl`) from committed assets (never re-fetched);
  `renderSynthesisPrompt` emits the presentation hierarchy + claim rules + a
  "always create links" contract (Jira key → `<jiraBaseUrl>/browse/<KEY>`, Task
  → `pa://task/<id>`, meeting → `pa://knowledge/<entryId>`/minutes URL) + the
  required JSON schema. `renderDayBriefingPrompt` reuses the SAME digest for the
  day chat session's single synthesis turn (Task 162) — same claim/linking
  rules, but asks for a concise human Markdown briefing (that turn's output IS
  the day report) instead of the machine JSON. The digest also carries
  per-bucket item `own` flags AND a top-level `myWork` slice (every OWN item
  across buckets, deduped, grouped by issue key) — the "what I did" signal kept
  separate from inbound attention and org-wide project activity; both synthesis
  prompts require the "Your work" section to draw ONLY from own items. It also
  carries TWO attendance slices, built by the pure, tested
  `buildAttendanceSlices` from the `meet-attendance` + `slack-huddles` +
  `calendar` snapshots (via `readAttendance`): `attendance` = meetings CONFIRMED
  by a session of mine (a self-matched Meet conference or a huddle I joined),
  with who was there and my own present time — the only entries the report may
  call attended and the only durations time logging may use; and
  `unconfirmedAttendance` (Task 224) = accepted calendar meetings and
  conferences that ran WITHOUT a session of mine, each with its `basis`
  (`no-self-session`/`identity-unavailable`/`calendar-only`/…), my calendar
  `response`, the CONFERENCE's `conferenceMinutes` (never mine) and `conflicts`
  (overlapping confirmed attendance). A conference correlated to its calendar
  event is reported once, keyed by the event's `readMeetLink` code (never
  another provider's link) and by title (which is how a nickname-linked meeting
  the collector correlated by time dedupes); a committed conference code is read
  with `canonicalMeetCode`, so any form it was stored in still compares equal.
  All-day events and ones I marked `transparent` (not busy — personal blocks,
  FYIs) are left out. Both synthesis prompts require the unconfirmed slice to
  stay out of "Your work"/"Meetings attended" and to be described as calendar
  acceptance with unconfirmed attendance. `renderLogMyTimePrompt` (Task 171) is
  the calendar "Log my time" turn: it seeds the day session with `myWork` + both
  attendance slices inline and tells the model to propose worklogs ONLY for own
  work, use the CONFIRMED durations, never log time from `unconfirmedAttendance`
  (ask instead), ask for durations it can't derive, verify against the real
  sources + `tempo_list_worklogs` rather than trust the digest, and confirm
  before writing.
- `relatedKnowledge.ts` owns `findRelatedKnowledge`: KB search across the day's
  salient terms (meeting/candidate titles, active-project labels, issue keys) to
  surface EXISTING durable entries so synthesis can say work "continues" prior
  work and link it. Excludes day-scan-owned entries (daily summaries,
  per-meeting entries, threads/tempo-profile) so the day never cross-references
  itself.
- `synthesisApply.ts` owns the application protocol (Decision #2): PREFLIGHT
  revision-sensitive proposals (candidate state, thread revision) before any
  irreversible effect → journal `applying` → idempotent Task creation (unique
  candidate→Task map) → ONE run-id-tagged KB commit (narrative region, threads
  store + projection, candidate statuses) → journal `applied`. `applySynthesis`
  resumes-not-duplicates (already-created Tasks via the mapping, an
  already-landed commit via its run-id subject);
  `reconcileDaySynthesisOnStartup` closes any run left non-terminal whose commit
  landed. Journal rows live in `../db/daySynthesisStore.ts`.
  `writeDayBriefingNarrative` is the lighter session-fold path (Task 162): it
  writes a ready-made Markdown briefing (the day chat session's synthesis turn)
  straight into the narrative region as the `day-synthesis` actor — no
  structured proposals, no journal — used by the interactive scan instead of the
  one-shot.
- `synthesisRunner.ts` owns the DaySynthesisRunner orchestration
  (`runDaySynthesis`): digest → injected synthesizer → validate → apply. The
  live model call is a seam (`setDaySynthesizer`), wired by `synthesisModel.ts`
  to a PROVIDER-AGNOSTIC one-shot run (dispatches pi vs Claude SDK on the
  `calendarDaySession` settings, like the minutes scanner) with a READ-ONLY
  `kb_read_asset` allowlist (no mutation tools). Independently retryable from
  collection.
- `tempoPlan.ts` owns the PURE Tempo-plan projection + reconciliation (phase 6):
  `renderTempoPlan` (the "My day" Markdown projection; dropped/cancelled hidden)
  and `reconcileAgainstWorklogs` (durable `clientId` match first, field-tuple
  fallback second, each worklog used once). The serialized state machine + rows
  live in `../db/tempoPlanStore.ts`. Exports the learned-profile entry id/path.
- `tempoProfile.ts` owns the learned `references/tempo-logging-profile` entry
  (JSON asset = source of truth) — now a full ROUTING profile: title→issue
  mappings (`matchTempoProfile`), responsibility-area→ticket routes
  (`matchAreaRoute`), Team Workflow category routes (`matchCategoryRoute`),
  per-issue default activity (`activityForIssue` over `ticketDefaults`), and a
  general fallback ticket (`generalIssueKey`), plus `roundDuration`, pure
  `upsertProfileMapping` (learning/correction; spreads-preserve the new tables),
  and `writeTempoProfile` (day-scan-owned commit rendering all tables). The
  `profitCenter` on area/category routes is a cached confirmation HINT only (a
  custom field that Jira automation sets; never written by us).
- `tempoDerive.ts` owns deterministic, model-free derivation via the routing
  ladder: `parseIssueKey` (first `KEY-123` in text), pure `routeMeeting`
  (explicit title key → title mapping → participant-area route; null = safe
  no-op), pure `deriveTempoProposals` (accepted+timed+routed meetings; records
  the chosen `basis:<kind>` and the `attendance:<kind>` evidence),
  `readMeetAttendanceEvidence` (the day's session-backed self-attendance PLUS
  the conferences that ran without a session of mine — negative evidence, each
  with its code, window and correlated calendar title), `areasByMeetingTitle`
  (meet-attendance participant names → contacts → areas, by normalized title —
  only confirmed conferences carry names), and `deriveAndPersistTempoProposals`
  (reads committed calendar+tempo+meet-attendance snapshots + profile, skips
  already-logged time via field-tuple, upserts rows preserving user intent).
  Wired into `collectionRun.ts` post-commit. ATTENDANCE EVIDENCE (Task 224): a
  meeting held over GOOGLE MEET is proposed ONLY when a participant session of
  MINE backs it, and then with MY present time (`attendance:self-session`) —
  accepted+occurred yields nothing, and the conference's own length is never
  logged. Meet-ness comes from `readMeetLink`, because a calendar fact's
  `meetingUrl` is the first conference link found anywhere on the event
  (conferenceData, location, description) and may be Zoom/Teams, and because a
  nickname/lookup Meet link carries no code at all (`isMeet` with `code: null` —
  still Meet-gated, matched by time). A meeting that cannot HAVE Meet session
  evidence — another provider, or no conference at all — still derives from the
  accepted slot, marked `attendance:calendar-only` so the proposal shows what it
  rests on. `assignAttendance` matches IDENTITY first (code ↔ code, best overlap
  then earliest start, so a standing link reused twice in a day never logs the
  same minutes twice) and only then TIME, for a conference whose space read
  failed or a slot whose link has no code. That time path is deliberately timid:
  a slot a same-day conference ran WITHOUT me at is never eligible
  (`ranWithoutMe` — that record is the Task-224 regression's own evidence —
  keyed by code when both sides have one, else by the record's
  window/`calendarTitle`, so a CODE-LESS nickname slot is protected exactly like
  a coded one), nor is a slot already identified by a conference of mine, and
  ambiguity credits NOTHING: a conference eligible for two slots, or a slot two
  conferences could claim, is left alone.
- `tempoApprove.ts` owns the approval driver: `approveAndSubmitTempoRow`
  (requestApproval → `beginExecuting` CAS → `submitDayTempoRow` real Tempo write
  → `finishExecuting`, then best-effort profile learning), `declineTempoRow`
  (the user's deliberate terminal "don't log this", `db` `declineProposal` →
  `declined`), and `cancelTempoRow` (proactive invalidation → `cancelled`).
  Backs the `/api/calendar/day/tempo/{approve,decline,cancel}` endpoints; the
  day-state projection hides `dropped`/`cancelled`/`declined` rows and a
  re-run's `upsertProposal` never re-proposes any of them. The actual write
  reuses `../tools/tempo/tempoTools.ts` `submitDayTempoRow`.
- `pathGuard.ts` owns the SERVER-SIDE day-chat guard (Decision #10): the tool
  wrapper `commitValidatedKnowledgeChanges` rejects ordinary (non-day-scan)
  commits that write a day-scan-owned asset or alter a day/meeting entry's
  GENERATED region; `## Notes`/narrative outside the markers stay editable.
  `day-scan`/`day-synthesis` system actors bypass it (they own these artifacts).

## Contract notes and rationale

- Snapshots/manifest/deltas/rollup are committed KB assets under
  `daily-summaries/<date>/assets/`; the day entry's machine data region is the
  ONLY generated part of `daily-summaries/<date>/index.md` (narrative +
  `## Notes` are never touched by collection). Raw API payloads and bodies go
  ONLY to the non-Git cache (privacy hybrid). No verbose worklog descriptions of
  others and no per-person hours reports in committed facts. EXCEPTION (Task
  171, explicit owner decision): ATTENDANCE facts for the user's OWN
  meetings/huddles may commit attendee display names + present durations (Meet
  participants; huddle participants via `users.info` + status) so the report can
  answer "who attended, what was it about, how long" — display names +
  status/durations only, never emails or message bodies.
- Every collection/synthesis KB commit uses the `day-scan`/`day-synthesis` actor
  names; the PA collector's self-exclusion AND the `pathGuard` bypass both key
  on them. Synthesis applies ONLY through `applySynthesis` (journaled +
  idempotent); never write day-scan-owned artifacts from ordinary agent tools.
- The synthesis runner MUST return the `synthesisSchema` structured result;
  free-form entry edits are never trusted, and source-derived text is untrusted
  data bounded by validation + the link allowlist.
- Task status changes must carry provenance (`UpdateTaskInput.actor`); a
  status-changing call site that omits it degrades to `system`.
- Wire changes to `CalendarDayState` are coordinated with `@assistant/shared`
  and the web calendar components.

## Verification commands

- `pnpm --filter @assistant/server test src/dayScan` for the focused suite (DST
  windows, delta classes, golden two-run fixture, cache rules, provenance).
- `pnpm --filter @assistant/server typecheck`; root `pnpm run build` before
  closeout.
