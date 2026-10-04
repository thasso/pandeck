# Background work service — reference

A descriptive snapshot of what the modules in `app/server/src/backgroundWork/`
own; the rules an agent must not violate stay in that folder's `CLAUDE.md`.
Correct or delete a section here when the code moves on. Relative paths in the
body are relative to that subtree.

## Purpose

The provider-neutral service layer for session-owned background work
([Task-467](pa://task/467), sliced as [Task-483](pa://task/483)). It decides WHO
may own background work, WHAT configuration governs it, and admits each item
before anything executes. The durable model underneath it landed with
[Task-482](pa://task/482) (`../db/backgroundWorkStore.ts`,
`../backgroundWorkRegistry.ts`, `../backgroundWorkBoot.ts`, migration
`0054_background_work.sql`); the wire types live in `app/shared/protocol.ts`.

This layer names no provider type. A Claude retained query and a PA-supervised
pi process reach it only through the ports in `backends.ts`, addressed by PA
item id. `architecture.test.ts` checks the import boundary the same way it does
for `mcp/` and `tools/`, and additionally rejects an import of the `claudeSdk/`
or `piSdk/` FOLDERS — without that, the SDK-package check is a no-op here, since
the global rules already forbid those packages outside their own folders.

## Module ownership

- `settings.ts` resolves the "Background processes" settings card into the
  numbers an admission freezes: `taskLifetimeMs`, `ownerSessionCap` (passed to
  the store as its `ownerLimit`), `claudeEmptyHostGraceMs`, and a `generation`.
  The card itself is an ordinary `AppSettings` section
  (`BackgroundWorkSettings`, defaults and ranges in `app/shared/protocol.ts`,
  normalized by `normalizeBackgroundWorkSettings` on both the read and the write
  path in `../settings.ts`): `enabled` default true; `ownerSessionCap` default 7
  in 1–20; `taskLifetimeMinutes` default 60 in 5–1440;
  `claudeEmptyHostGraceSeconds` default 30 in 0–300. Out-of-range numbers clamp
  to the nearest bound and non-numeric values fall back to the default, so a
  hand-edited file can produce neither an unbounded lifetime nor a zero cap.

  The generation is the card's exact INDEX among all cards the ranges permit —
  mixed-radix packing, one digit per field — not a counter and not a hash. The
  whole normalized domain is 2 × 20 × 1436 × 301 = 17,289,440 cards, which
  numbers exactly inside the safe-integer column, so a hash would buy nothing
  and cost collisions: an earlier 31-bit FNV-1a encoding aliased
  `cap 1 / lifetime 307 / grace 96` with `cap 1 / lifetime 539 / grace 214`, and
  two different frozen policies sharing a generation would silently claim to be
  the same configuration. `settings.test.ts` walks the whole domain and asserts
  the packing is one-to-one and onto.

  Content-derived rather than counted is still the point: equal settings give
  equal generations across restarts, and a snapshot can never carry one edit's
  numbers under another edit's identity — the read/edit race a counter would
  have. Nothing compares two generations for order; a frozen row only records
  which configuration governed it. The function normalizes its input first, so
  an unnormalized card packs as the card it clamps to rather than as some other
  card's index.

- `policy.ts` owns eligibility. Only an interactive top-level `user`-scoped
  session may own background work, because background work outlives the provider
  turn and somebody has to be able to see and stop it. The decision is split:
  `backgroundWorkOwnerDecision` is pure over `BackgroundWorkOwnerEvidence`, and
  `readBackgroundWorkOwnerEvidence` is the only place that reads durable state
  for it. The exclusions are enumerated — `unknown-session` (a helper or
  one-shot run has no session record at all), `non-user-scope` (`internal`
  covers the server's own helper runs, `subagent` the delegated ones),
  `subagent-owned`, `workflow-owned`, `harness-backend-mismatch` — and every
  read fails closed. The last one is a CAPABILITY question, asked through the
  shared `harnessSupportsBackgroundWorkBackend` predicate: Claude background
  work executes inside the retained query that issued it, PA-supervised pi work
  does not, and neither runtime can hold the other's. Admitting the mismatch
  would create a row nothing could ever bind, stop or close, so a pi session
  naming `claude-query` (or a Claude session naming `host-process`) is refused
  even though its scope and ownership are impeccable. Both ownership questions
  answer "owned" on ANY edge rather than trying to decide whether a past
  assignment has finished: a session the engine or a parent ever executed is not
  the user's interactive top-level session, whatever state that assignment is in
  now. A peer session an agent spawned is NOT excluded: it is the user's own
  session, visible in the sidebar and promptable, and the spawn edge is
  provenance rather than ownership. The subagent-thread check is normally
  implied by the persisted scope; it is asked directly because the thread edge
  is what the rule is about, not because the scope invariant is doubted. Nothing
  here branches on a persona or agent type.

  Excluded contexts keep ordinary foreground execution untouched — this policy
  governs admission to BACKGROUND work and changes no existing execution path.

- `service.ts` owns admission, the single door background work enters through.
  `admitBackgroundWork` answers a RETRY first —
  `backgroundWorkStore .getItemBySource` — before any mutable policy is
  consulted, because the store's idempotency returns the original row and
  judging that row against today's settings is the bug: the caller would be told
  `disabled` about work still `pending-launch`, or handed the original row
  carrying a generation and an empty-host grace that were never frozen on it. A
  retry answers with the row whatever state it reached, so it can never
  resurrect work that already ended, and reports `reused: true`. Provider work
  first seen after execution also enters through `admitBackgroundWork` with
  `observed: true`; it cannot be denied after the side effect, so the same door
  calls `observeItem` to adopt capacity or record an over-cap epoch without
  evicting another owner.

  For a new request it resolves the settings snapshot once, checks `enabled` and
  eligibility, then calls the store's `reserveItem`, which reserves the item and
  — when the owner does not already hold one — the owner slot in one
  `BEGIN IMMEDIATE` transaction. The last free slot is therefore decided by the
  database: two admissions racing for it produce exactly one winner and exactly
  one row, and the loser gets `at-capacity` with nothing persisted. A second
  child of an owner that already holds a slot reuses it for free; the cap counts
  SESSIONS, and there is no configured child ceiling.

  Denials are bounded and enumerated (`disabled`, `ineligible-owner`,
  `at-capacity`, `host-over-cap`, `invalid-request`) so a caller can say
  something different for "the user turned this off" than for "every slot is
  busy". `host-over-cap` is recognised before `at-capacity` because
  `BackgroundWorkOverCapEpochError` extends the capacity error and means that
  epoch can never take admitted work, whatever capacity is free — a caller
  retrying on a free slot would loop. Every ordinary refusal is a return value,
  never a throw.

  A caller may request a shorter lifetime. Admission validates it as a positive
  safe integer and freezes `min(requestedLifetimeMs, taskLifetimeMs)`; the
  Settings lifetime remains the upper bound and the supervisor remains the only
  deadline authority.

  The frozen values are the whole point, and an admitted answer carries them as
  `BackgroundWorkFrozenPolicy` — lifetime, deadline, generation and the host
  epoch's grace, read back from the ROW and its host rather than from the
  snapshot that produced them. Deliberately not the settings snapshot: `enabled`
  and the owner cap are admission-time policy that nothing freezes, and handing
  them to a launch would invite a backend to act on a value that never governed
  this work. Disabling the feature or lowering the cap blocks LATER admissions
  and never kills, evicts or re-deadlines work that is already running.

- `backends.ts` is declarations only — no implementation, no timer, no provider
  import. It states what a provider backend must supply
  (`BackgroundWorkBackendPort`: `launch`, `stop`, `stopAll`, and `closeHost` for
  a backend that retains a host epoch) and what it reports back into
  (`BackgroundWorkBackendEvents`: `providerBound`, bounded lossy `activity`,
  safe `outputCaptured` metadata, and terminal `completed`). Activity is a
  delivery hint and never durable row content; output evidence and terminal
  facts reach durable state before delivery. `BackgroundWorkLaunchRequest`
  carries the FROZEN deadline and empty-host grace verbatim, so a backend cannot
  re-read live settings for work already admitted, and a `launched: false`
  acknowledgement is the honest "nothing started" the service turns into
  `failLaunch`. A vendor task id, an OS process or group id, a socket handle, a
  path, an environment or an output body never crosses this boundary;
  `providerBound` is the one exception, and it is a write into the store, where
  the id is evidence rather than an address. The command line does travel — as a
  FACT about the row (bounded at admission, see `title.ts` and the store's
  `boundedCommand`), never as anything a port executes from. Stop-all also
  carries whether an ordinary prompted turn is inside its protected boundary, so
  an adapter can defer host closure without weakening the durable Stop
  reservation.

- `title.ts` is the one wording of an item's human title, shared by both
  backends: the agent's description when it gave one (Claude's Bash and Monitor
  take one natively; pi's shadow `bash` grew an optional `description` that its
  schema marks as meaningful only with `run_in_background`), else the first
  non-empty line of the command, else the caller's fallback. Whitespace
  collapses and the result is cut to the store's 200-character label cap. The
  fixed strings the rows used to carry ("Background shell command", "Observed
  Claude background shell") are now only fallbacks for a job with neither.
  `admitBackgroundWork` passes `description` and `command` through to the store
  beside the label; the store cuts the command at 4 KB and records the cut in
  `command_truncated` (migration `0059_background_work_command.sql`).
  `completionDelivery.ts` puts all three — beside `outcomeSummary`, which the
  card shows only when opened — on the browser card's presentation, and the
  command deliberately NOT in the model-only context block: the model issued the
  tool call and can read it back from its own transcript, and a 4 KB script per
  completion is prompt spent on nothing.
- `supervisor.ts` owns launch acknowledgement, frozen deadline timers, Stop,
  completion, and deployment drain. Tests inject its clock; production timers
  never appear in race tests. A targeted Stop reserves `requestStop` before it
  calls a port and re-reads the row immediately before each effect. Each attempt
  has a ten-second acknowledgement window and one automatic retry. An
  acknowledgement terminalizes the item as `stopped`; two unanswered attempts
  leave the row running with `stopState: unconfirmed`. A later explicit request
  identity may try again. A Stop that wins while the row is `pending-launch`
  records `not-started` / `stopped-by-owner` and `launch` does not call the
  backend. A Claude Stop between `markRunning` and `bindProvider` remains
  `awaiting-binding`; `providerBound` starts the targeted attempt after the
  authoritative binding is durable.

  `stopAllOwner` reserves every item's Stop, reserves the retained host's
  Stop-all when one exists, then calls each owner/backend port once. Repeating
  the same source identity creates no second effect. The owner-facing tool
  supplies its caller identity: an owner-invoked Stop-all protects the calling
  provider/tool turn from both interruption and host closure, while a human
  Stop-all retains the ability to interrupt a background-origin turn. Targeted
  Stop failure never scans OS processes, signals an inferred process, closes a
  host, or affects a sibling.

  `closeIdleHost` rechecks durable membership after the backend's frozen quiet
  grace, closes through the port, and records the host closed. `hostLost`
  terminalizes every active child as lost when a retained process exits without
  an intentional close.

  `completed` terminalizes first, then gives `completionDelivery.ts` a bounded
  in-memory notice, which `deliveryPolicy.ts` sorts into one that earns a turn
  and one that merely has to be known. The principle it encodes is that some
  events must be KNOWN before the next action while none of them justify
  CREATING one, and it exists because unconditional delivery was measurably
  expensive: in one session, 23 background-delivery turns against 26 human ones,
  38 of 49 items settling while a turn was already running, and eleven turns
  answered verbatim "No response requested." A no-op wake costs a full context
  read — median context at those turns across all sessions was 226k tokens — and
  permanently enlarges the transcript every later turn pays for.

  The disposition is two-way. `wake` means the fact must reach the model on its
  own account; `defer` costs no turn and reaches it on the next one. Nothing is
  discarded.

  Two reasons DEFER. A requested Stop is already answered wherever it came from:
  the agent holds the terminal row its `background_tasks` stop call returned,
  the human is looking at the UI they clicked, and a frozen-deadline Stop spends
  a budget the agent set itself. Those three are deliberately not distinguished,
  since keying on a stop reason string would couple the policy to supervisor
  wording — but the reported reason stays specific so a log or test can tell the
  rules apart. And a `claude-query` item settling inside a live turn defers
  because a turn was there to receive whatever the CLI injected for itself,
  which makes a turn of PA's own redundant.

  The one Stop that WAKES is the one nobody requested. `stopOrigin: "system"`
  covers PA stopping work the owner neither asked for nor could predict — today
  only the monitor event-rate Stop — where the row alone leaves the agent
  believing its monitor is still watching. Deferring there would confirm that
  belief by saying nothing, which is the exact failure the Stop exists to end.
  It is a TYPED origin, decided in `index.ts` by comparing the row's
  `terminalReason` against the supervisor's own exported constant, so the
  exception does not reintroduce the wording coupling the rule above forbids.

  An earlier revision DROPPED that second case outright, on the reasoning that
  the CLI's `<task-notification>` had already put the fact in the transcript.
  Review found the premise unprovable from this evidence, and the code disproves
  it twice: `ClaudeSdkSession` terminalizes from the Stop snapshot precisely
  WHEN a notification is missing, and it does not consult the SDK's
  `skip_transcript` flag. Both sample a running turn, so both would have been
  dropped with the fact living nowhere but the UI. A bounded block on the next
  turn is the cheap side of that trade; a fact the model never learns is not.
  `backend` plus turn-running is not evidence of transcript membership, and
  nothing should treat it as such without carrying positive evidence of the
  specific terminal event.

  Deployment drain is absent from the policy rather than deferred by it. A
  drained item never reaches delivery at all: `supervisor.ts` suppresses
  `completionRecorded` while draining, and the hub stops delivery when it closes
  admission. A branch for it would be unreachable code advertising a guarantee
  the system does not make, and the in-memory queue would not survive the
  restart in any case — restart resumes nothing, and a drain fact lives in its
  row and the UI.

  What remains — settling while the session is idle, with no Stop and no drain —
  is the parked case, the one where no turn means no delivery.

  A `wake` is a requirement that the fact arrive on its own account, not an
  instruction to start a turn, and delivery satisfies it as cheaply as it can. A
  driver that reports `canSteer` gets the notice steered INTO its running turn
  instead: the same fact for the price of a message rather than a whole turn,
  which is what the Claude CLI does for itself and what a `host-process` session
  otherwise has no way to get. The steer uses `steerOnly`, so the DRIVER decides
  from its own live streaming state; PA's `isRunning` read is a moment old by
  the time the request lands, and the events that produce a background notice
  are frequently the same events that end turns, so an automatic sender loses
  that race far more often than a human clicking mid-turn does. A refusal
  (`SteerNotTakenError`) is reported as `busy`, which retains the batch for the
  next idle drain rather than losing it — the fallback the old code skipped when
  it reported a freshly started turn as a successful steer. The adapter also
  AWAITS pi's acceptance: the driver answers "steered" the moment it hands the
  text over, before pi's own promise settles, and pi refuses to steer an idle
  harness — so trusting the synchronous outcome reported a rejected steer as
  delivered, the same silent loss one layer deeper. The attempt carries a
  distinct `clientRequestId` from the fallback's, because it registers that
  identity with both the runtime and the pi driver before pi can reject
  asynchronously; sharing the key would let a failed steer answer the later
  ordinary delivery "already handled". Every failing exit from the `steerOnly`
  branch releases the runtime's dedup key for the same reason. A steered
  delivery deliberately does NOT enter `backgroundCompletionTurns`: the turn it
  joined is the user's own and must stay protected from Stop-all.

  "Was a turn running" is sampled when the terminal fact becomes durable, never
  re-read at drain time: the queue only drains when the session is idle, so a
  late read always answers "no" and the question is precisely whether a turn was
  live to receive the provider's own notification.

  A deferred notice is not dropped. It is held per session, bounded like the
  wake queue but evicting the OLDEST on overflow (deferred work waits for a turn
  that may never come, while a wake queue drains in seconds), and rendered into
  the same model-only JSON under a different preamble. `runtimePrompt.ts`'s
  `withDeferredBackgroundContext` folds it into the next eligible turn's
  `contextBlock` — beside the Plan hint, excluded from the durable log and the
  client projection — so the fact reaches the session before it acts again at no
  turn cost. Steering follow-ups and hidden rebuild/fork prompts are excluded:
  neither is a turn the agent reasons in. Reading is non-destructive and
  `commit` rides `onUserEntry`, so a refused or deduplicated turn cannot consume
  the only copy, and the committed set is snapshotted at peek time so a notice
  deferred in between is not dropped unsent. The deferred preamble states that
  it is context rather than a request and makes NO claim about the turn carrying
  it — the failure it avoids is one this system produced: a provider
  notification prepended to a human turn under the assertion "no human input has
  been received" caused a genuine user question to be answered as though the
  turn were empty.

  Activity notices are unaffected and still wake. They exist only for a
  `host-process` MONITOR, where the lines ARE the awaited result. A background
  shell command produces none: it is awaited at its exit, its log is a file the
  agent reads if it wants to, and the same code path used to push it a batch
  every 30 seconds for as long as it ran — 31 turns for one `make dev` before
  this was split. `launchProcess` branches on `kind`, and both kinds still
  capture the whole output artifact. Non-terminal backend activity uses the same
  queue and model path. Producers batch activity through `monitorBuffer.ts`,
  which caps lines and UTF-8 bytes and reports dropped-event counts. The app
  writes each activity batch to a private turn-scoped file and removes it after
  delivery; raw process output never enters the prompt. These notices are
  delivery hints; completion remains in the background-work row when no session
  is listening, while activity may be lost. Delivery first awaits the existing
  durable peer FIFO's `drainRecipient`, then checks that the session is idle and
  submits one bounded mixed batch through `promptRuntimeSession` with a durable
  item/revision request key. The durable user entry contains only
  `Background work updated.` plus a compact typed origin presentation for the
  browser. Model-only `contextBlock` carries valid JSON with PA task ids,
  status, links, output metadata, and the local file path the agent may read. It
  marks every field as data rather than an instruction and makes no demand for a
  user-facing response. The renderer drops whole updates at its character cap,
  so truncation never produces broken JSON. A busy result keeps the notice and
  its activity file for the next idle hook rather than queueing or preempting a
  turn. Human prompts retain the existing `SessionBusyError` behavior; there is
  no human prompt queue. Claude's provider-specific notification handler records
  one bounded output artifact attempt before terminalizing the item. PA gives
  each child a private 0700 `TMPDIR` and records its `claude-${uid}` directory
  as the epoch root. The artifact is made only from an owned regular UTF-8 file
  opened without following symlinks under that root. ANSI and unsafe terminal
  controls are removed, and files over 64 KiB keep only the first and last 32
  KiB. Oversized files are refused before scanning. Refusals store metadata
  only. The durable item points to the generated artifact identity. Vendor paths
  and output bodies never cross the provider-neutral boundary; delivery resolves
  the PA-owned artifact to a stable local path only in model context.

- `monitorBuffer.ts` bounds pending monitor line events by line count and UTF-8
  byte count. Events beyond either cap become a dropped-event count in the next
  batch instead of growing an unbounded queue.

- A monitor's notification unit is a LINE, not a clock tick. The 200 ms
  coalescing window exists only to keep output that arrived together — a stack
  trace, a burst of CI results — in one notification, so a well-filtered monitor
  reports promptly instead of up to 30 seconds late.

  Selectivity is the agent's job and lives in the command it writes, exactly as
  in Claude's native `Monitor`: there is no filter parameter, stdout IS the
  event stream, and `PI_MONITOR_TOOL_DEFINITION` teaches the convention
  (`grep --line-buffered`, per-stage flushing, cover the failure signatures too
  because silence is not success). The backstop for ignoring it is
  `ACTIVITY_RATE_MAX_PER_WINDOW` notifications per `ACTIVITY_RATE_WINDOW_MS`:
  past that the backend mutes the stream and reports `activityRateExceeded`, and
  the supervisor STOPS the item. Muting alone was the old `ACTIVITY_WAKEUP_MAX`
  behaviour and is the one outcome to avoid — a live monitor nobody hears from
  is indistinguishable from one with nothing to say, so the agent must be told
  and left to re-arm with a tighter filter.

  Telling it takes an explicit hop that review caught missing. `stopOne` →
  `runTargetedStop` terminalizes the row ITSELF and returns; only the backend's
  `completed` event reaches `completionRecorded`, and the pi backend suppresses
  that event once `stopping` is set. A targeted Stop is therefore SILENT by
  design — correct for every Stop that has a requester, wrong for this one. So
  `activityRateExceeded` hands the terminal item to `completionRecorded` itself,
  and only when its own call is what stopped the row: `already-terminal` means
  `completed` beat it there and has notified, and `stop-unconfirmed` leaves a
  nonterminal row with no fact to send. Without that hop the
  `stopOrigin: "system"` branch is unreachable, which is why the regression test
  asserts the delivery seam and the policy decision rather than the row alone.

- Boot reconciliation sweeps only owned `pa-claude-<pid>-*`, `pa-pi-<pid>-*`,
  and `pa-background-delivery-<pid>-*` temp trees whose owning pid is provably
  dead. The supervisor registers with `hub.ts`'s existing reload and SIGTERM
  lifecycle authority. The hub closes background admission as soon as drain
  starts, waits for ordinary prompted turns without counting background work in
  `runningCount()`, then invokes the supervisor. The supervisor samples active
  work, allows its bounded natural-completion grace, records
  `stopped-for-deployment`, stops each remaining owner through its port, closes
  retained hosts through `closeHost`, and returns only after the store writes.
  Boot reconciliation still resumes nothing. A planned drain becomes the more
  specific stopped outcome only when its Stop was not left `unconfirmed`. If
  force-exit abandons an unconfirmed deployment Stop, boot records `lost` with
  `deployment-stop-unconfirmed` and preserves the unconfirmed Stop evidence. One
  accepted honesty window remains: `recordPlannedDrain` stamps rows before grace
  and Stop effects, so force-exit during grace or the first attempt boots as
  `stopped` / `stopped-for-deployment`. The process ended the work either way,
  and no row auto-resumes; this limitation is deliberate rather than a claim
  that the targeted Stop was acknowledged.

## Owner-facing catalog

`../tools/backgroundTasksTools.ts` registers one deferred `background_tasks`
tool in the shared catalog for eligible interactive user sessions on either
harness. It derives ownership from the calling tool context and the shared
background-work policy, then reads only the canonical store projections. Its
operations are bounded `list`, `status`, `stop`, `stop_all` and `set_intent`;
`stop` and `stop_all` delegate entirely to `supervisor.ts`. `set_intent` records
whether the owner waits on a nonterminal item (`awaited`, every item's default)
or keeps it beside its work (`service`: a dev server, a watcher) —
`backgroundWorkStore.setIntent`, column `intent` from
`0067_background_work_intent.sql`. The session list's
`SessionBackgroundActivity.serviceCount` carries it, and the browser reads a
service as running but never as work in progress. A launch tells the agent the
item's PA id and how to declare it (`backgroundWork/intent.ts`): in the pi tool
result, and for Claude as the admitting PreToolUse hook's `additionalContext`,
since Claude's own task id is not an address this tool accepts. PA task ids are
the only model-facing address, `all` is active-first, and history uses a keyset
cursor over immutable creation/id keys so pages do not overlap or skip when rows
are touched or new rows arrive. Results contain no provider handles, process
ids, vendor paths, environments, credentials, or output bodies. When PA retained
output, the result includes its stable PA-owned `outputFile` so the agent can
inspect it without listing every item to rediscover the completion. Completion
is delivered automatically; list/status are recovery and inspection, not
polling. The tool is a deliberate Plan-mode safety exception so existing work
remains inspectable and stoppable while new admission is disabled.

## Human-facing Stop

`../backgroundWorkHumanStop.ts` is the browser's door to Stop
([Task-486](pa://task/486)). `connection.ts` answers `stopBackgroundWork` and
`stopAllBackgroundWork` through it, and it calls `supervisor.ts`'s `stopOne` /
`stopAllOwner` DIRECTLY — never `background_tasks`, whose authorization is a
model in the owning session rather than the user. Two callers, one authority.

A human addresses work by PA item id alone: the owner is read back from the
durable row, and the id is bounded before anything is read. Stop-all sends no
`callerSessionId`, since that value is what the supervisor reads as "the owner's
own turn is asking"; a human is not that caller, so an ordinary prompted turn is
protected by the supervisor while a background-origin turn is not.

The `backgroundWorkStopAnswer` frame is CONTROL feedback: per-item outcomes
(`stopped`, `already-terminal`, `awaiting-binding`, `stop-unconfirmed`,
`unknown`) that retire the pressed button, plus `hostCloseWaiting` when a
retained host is still open after Stop-all. Every row FACT still travels as a
`background` state event, so an unconfirmed Stop stays visibly nonterminal.
`hostCloseWaiting.protectedTurn` reads the deployment's one
`backgroundCompletionTurns` tracker (exported from `completionDelivery.ts`, and
the same instance `index.ts` configures the supervisor with) purely to EXPLAIN a
wait the supervisor already decided.

## Provider implementations

The Claude port lives under `../claudeSdk/backgroundWorkBackend.ts`; this folder
keeps no provider import. The pi port is under
`../piSdk/backgroundWorkBackend.ts`. The human registry, session-card chip and
Settings card live in `app/web` (`docs/reference/web-*.md`).
