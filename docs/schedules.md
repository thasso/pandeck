# Schedules

A Schedule sends a prompt at a wall-clock time, once or repeating, either into
an existing session or as the first prompt of a new session. The user and agents
both create them; the user sees and controls every one.

This contract was agreed on 2026-11-25 ([Task-1498](pa://task/1498)). Phase 1 is
being built ([Implemented so far](#implemented-so-far)); the phases at the end
say what lands when. The motivating stories:

- A user's roadmap update agent runs automatically on Mondays at 11:00.
- An agent gets a prompt back as a reminder today at 15:45.
- A user sees the schedules set for a session, sees every schedule in one place,
  disables or removes them, and edits a schedule's prompt, target and, for new
  sessions, account, model and effort.

## Terms

- **Schedule**: the definition — prompt, timing, target, state.
- **Occurrence**: one due time of a Schedule and what became of it. The UI says
  "Next occurrences" and "History".
- **Scheduled prompts**: the delivery lane that hands an occurrence to an
  existing session.
- **Schedule clock**: the server timer that claims due occurrences.

Do not call an occurrence a run (Workflow Runs are another concept), a reminder
(the `reminders` lane is the reply reminder) or a wake (a payload-free scheduler
request, `glossary.md`). The schedule clock is never "the scheduler": that is
the per-session delivery scheduler. A Schedule is unrelated to a Task's
`scheduledFor`, which is the day the user plans to work on the Task.

## What a Schedule holds

- **Id:** `sch_<n>`, linked as `pa://schedule/<id>`.
- **Name**, **prompt** (plain Markdown), **enabled**.
- **Timing:** `once` at a local date and time, or a repeat preset — daily,
  weekdays, weekly on chosen days, monthly on a day — at a local time, with
  optional `startsOn` and `endsOn`.
- **Time zone:** an explicit IANA zone, the user's zone when the Schedule was
  created. It does not follow later profile changes.
- **Target:** an existing session, or a new session (below).
- **createdBy:** the user, or the session that created it. History only.
- **controlledBy:** who may change it without a card (Who may change what).

Prompts carry no attachments and no `/skill` command. A prompt may ask the agent
to use a skill, and an agent definition brings its own skills. There are no
placeholders such as `{{date}}`: the occurrence header gives the time.

### Timing rules

`nextOccurrencesAfter(timing, afterMs, n)` in `app/shared/` is the one
implementation. The server arms the clock with it, the web previews the next
three occurrences with it, and the tools echo them with it.

- Local wall-clock time in the Schedule's zone. 11:00 stays 11:00 across a
  daylight-saving change.
- A local time that does not exist (spring forward) occurs at the next valid
  minute. A local time that exists twice (fall back) occurs once, at the first.
- Monthly on day 29–31 occurs on the month's last day when the month is shorter.
- `startsOn` and `endsOn` are inclusive local dates: the first and the last date
  that may occur.
- An occurrence's due time is that scheduled instant (a whole minute, or the end
  of a gap), never the time it was delivered. The function returns due times
  strictly after `afterMs`, and the clock compares them to the millisecond.
- Nothing repeats more often than once a day. Polling for a condition belongs in
  `Monitor` or background tasks, not in a Schedule.

## Targets

### An existing session

Each occurrence is delivered to that session through the scheduled prompts lane.
This is how a Schedule gets standing permissions: the user sets the session up
once, grants it what it needs (for example Jira edits, through the inspector or
`approval_grants_request`), and the Schedule prompts it repeatedly. Automatic
compaction bounds its context.

### A new session

Each occurrence starts a fresh session. The target holds a persona or agent
definition, a Project, an optional Task, and the runtime: provider, model,
account (a pinned profile or automatic) and effort.

- The session is a top-level user session: no `spawned` edge, so no inherited
  grants and no peer reporting duty. It has only what its agent definition gives
  it.
- It starts where a session the user creates in that Project starts. There is no
  worktree in the target; the agent creates one when it needs it.
- The agent definition is read at occurrence time. The Schedule's explicit
  runtime overrides the definition's defaults.
- **Enterprise requirement.** Every agent-authored creation, prompt change or
  change to a new-session target captures the proposing session's enterprise
  requirement before its first await, the way `buildSpawnProposal` does
  (`account-routing.md`). The Schedule's requirement is its previous value OR
  the captured one: it can be added, never cleared, and no card edit, UI edit or
  runtime change clears it. It is sealed server-side, not an editable field.
  Account resolution at occurrence time and session admission enforce it, even
  when the proposing session has since been deleted. A user-authored Schedule
  requires enterprise only when the user sets it.
- Title: "<Schedule name> — <local date>", e.g. "Roadmap update — Mon 30 Nov".
  The session and the Schedule are joined by a `links` edge.
- A linked Task being completed or archived does not affect the Schedule. The
  detail view shows the Task's state.

Repeating Schedules default to a new-session target. An existing-session target
is equally supported.

## Occurrences

### Claiming

The schedule clock keeps one timer on the earliest `next_due_at_ms` of the
enabled Schedules, capped at 24 hours so it re-reads the wall clock after sleep
or drift. Every Schedule write, a change to the Schedules settings and boot
re-arm it.

The same timer carries the maintenance sweep (Retention). Its deadline is due at
boot and moves to 24 hours after each sweep that completes; re-arming never
moves it later, so a steady stream of writes cannot starve the sweep. The timer
fires at the earlier of the next due time and that deadline. A tick that fails
is logged and runs again no sooner than a minute later, never in a tight loop,
and a failed sweep keeps its deadline.

Claiming is one transaction: insert the occurrence row (unique on
`(schedule_id, due_at_ms)`) and advance `next_due_at_ms` to the next future
occurrence. An occurrence is therefore claimed at most once across restarts.

### Late and missed

- An occurrence found late — at boot, or by a timer that fired late — is claimed
  if it is no older than the grace window (setting, default 60 minutes), and
  recorded `missed` otherwise.
- At most one late occurrence per Schedule is claimed; earlier ones are
  `missed`. There is no backlog replay.
- **Pause all** (one switch on the Schedules page) stops the clock from
  claiming. Occurrences due while paused are `missed` and do not catch up on
  resume; the grace window covers server downtime only. Pause stops NEW claims
  only: an occurrence claimed before the pause stays owed and may still be
  delivered, and a due time missed while paused does not supersede it. What
  counts is when the due time fell, not when the clock got to it (a late timer,
  a failure back-off, a restart). So each switch is one transaction that first
  settles every due Schedule under the state BEFORE the switch, then flips it:
  - A due time at or before the switch instant belongs to the state before it.
    Pausing claims one that fell unpaused and was not ticked yet (latest within
    the grace window, superseding as usual); resuming records one that fell
    while paused `missed`.
  - A due time after the switch falls in the new state and is settled by its
    tick: claimed after a resume, `missed` while paused.
  - Every pause and resume settles its own interval, so a due time in an
    unpaused gap between two pauses is claimed by the second pause.

  The switch is stored in the database, never in memory, so a restart keeps it.
  If the transaction throws before it commits, nothing of it stays. Once
  committed it stands, even when the settings save then fails.

- **Edit and disable cut over the same way.** An edit first settles the
  Schedule's due times at or before the write instant under the OLD definition,
  exactly as a tick would (one late claim within the grace window, the rest
  `missed`; paused, `missed`), then applies the change. A new timing takes
  effect from its first occurrence after the write instant; a timing equal to
  the stored one keeps `next_due_at_ms`. A disable settles the same way and then
  withdraws what it claimed: a due time inside the grace window is `withdrawn`,
  an older one `missed`.

### States

`claimed` is the only open state: the occurrence is owed. It ends in exactly one
terminal state: `delivered` (existing session), `started` (new session),
`superseded`, `withdrawn`, `failed` or `missed`. Each row records the due time,
the claim time, the frozen input (below), the target session once known, and any
error.

- **Frozen input.** Claiming copies the prompt, the target and, for a new
  session, the runtime and enterprise requirement into the occurrence. Delivery
  reads only that copy, never the Schedule. An edit to the Schedule affects
  later occurrences, never a claimed one; to drop a claimed one, disable or
  delete the Schedule.
- **One undelivered occurrence per Schedule.** A newer claim for the same
  Schedule supersedes a still-`claimed` earlier one in the claim's transaction.
  The survivor is delivered when the session can take it, with no expiry; its
  header shows the original due time.
- **Disabling or deleting** a Schedule withdraws its `claimed` occurrence in the
  same transaction. Deleting also removes the Schedule's history.
- **An attempted occurrence ends by its evidence.** When a newer claim, a
  disable, an edit or a Pause boundary ends a `claimed` occurrence whose
  delivery was already attempted, the same transaction first looks for its
  admission key: found, it is `delivered`; unreadable, `failed` with "delivery
  uncertain"; absent, `superseded` or `withdrawn` as usual. This adds no state
  and no hold, and it is how "after the append nothing retracts it" holds when
  bookkeeping failed after an append.
- **Terminal states are final.** A settled occurrence never changes again.
- **What keeps it `claimed`.** A running turn, a Stop, a pending runtime
  selection that cannot apply, and a session that cannot be acquired right now
  are holds: the occurrence stays owed and is offered again on the next wake.
- **What makes it `failed`.** A new session that cannot be created (agent
  definition gone, pinned account unavailable, enterprise requirement unmet);
  any other refusal or error before the append for an existing session (the
  bound account no longer offers the model, an unmet enterprise requirement, an
  unavailable checkout), recorded with its concrete reason; or delivery whose
  outcome is unknown (below). A runtime that returns without admitting the
  prompt, with no hold, is a refusal before the append, recorded as
  `delivery failed: the target runtime returned without admitting the scheduled prompt`.
  Only the four holds above keep an occurrence `claimed`; a recorded reason is
  at most 500 characters. A failed occurrence is never retried, and its Schedule
  needs attention.

### Admission and crash safety

`delivered` and `started` mean the prompt was durably appended to the target's
transcript — not that the session exists, and not that the turn finished.

- **One admission key per occurrence**, `schedule:<occurrence id>`. It is the
  `clientRequestId` of the append for an existing session and of the opening
  prompt for a new one, as the prompt queue uses for its rows.
- **Final admission check.** The lane rechecks that the occurrence is still
  `claimed` at the last no-await admission boundary, through the lane's
  late-admission guard. A supersede, withdrawal or Stop that commits before that
  point prevents the append. After the append nothing retracts it: disabling the
  Schedule does not stop that turn, and a bookkeeping failure after the append
  never stops it either. If the `delivered` settle at the append rolls back, the
  lane retries it once, right after the turn's receipt, while the occurrence is
  still `claimed`. A settle that committed but whose hand-off then failed is
  already `delivered`. Only if that retry fails too does the occurrence stay
  `claimed`, until recovery or the next ending finds the key.
- **Recovery.** At boot, and before retrying a `claimed` occurrence the server
  may have tried before, the server looks for the admission key in the target's
  canonical transcript, as peer-prompt recovery does. It reads complete records
  only; a corrupt or torn record that holds the key makes the outcome unknown.
  Found: the occurrence is `delivered` or `started`. Absent: retry. Unreadable:
  the outcome is unknown, never proof of absence, so the occurrence is `failed`
  with "delivery uncertain" and the Schedule needs attention. It is never sent
  twice.
- **New sessions.** Creation is keyed to the occurrence on both harnesses. The
  Claude harness accepts a supplied session id; pi mints its own. So the
  occurrence is recorded on the session (its Schedule link, written when the
  session row is created), and recovery finds the session by that key. A session
  found without its opening prompt gets the prompt through the same keyed
  append, rather than a second session being started. Phase 3 picks the creation
  seam.

### Overlap

No overlap check. An occurrence fires even when the previous one's session is
still running or waiting on the user: an existing-session target queues it
behind the running turn, and a new-session target starts another session.
Telling a stale previous occurrence from the user's own ongoing conversation is
not reliable.

### Retention

A Schedule keeps its last 50 terminal occurrences; older terminal rows are
pruned. A `claimed` occurrence is owed and is never pruned. After long downtime
at most the newest 50 missed due times are recorded.

A Schedule becomes `done` when it can produce no further occurrence and its last
one is terminal: a `once` Schedule after its single occurrence, a repeating one
after the last occurrence before `endsOn`. A `done` Schedule leaves the default
list for the Done filter and is deleted with its history 30 days after it became
`done`, never counted from the due or claim time: `done_at` is stamped by the
transition that leaves nothing owed and nothing due (the settle of the last
`claimed` occurrence, not its claim). A disabled Schedule's timing can run out
with no write to notice it; the maintenance sweep then stamps `done_at` at its
own time, at most a day late, never backdated to the last due date. An edit that
gives a `done` Schedule a future occurrence makes it active again. Deleting a
Schedule deletes its history.

## Delivering into an existing session

The `scheduled prompts` lane in `app/server/src/sessionDeliveryLanes.ts` sits
after the peer lanes and before background completions.
`mayJoinRunningTurn: false`: an occurrence never steers into a running turn. It
waits until the session is idle and starts a turn once the higher-priority lanes
(handoffs, the user's queue, workflow assignments, peer prompts) owe no
admissible work. It does not use the user's prompt queue, which can be paused or
held and whose rows count as the user typing.

- **Stop holds it.** An occurrence is an automatic turn
  (`steering-and-queueing.md`, "Stop holds automatic turns"). On a Stopped
  session it waits as the Schedule's one undelivered occurrence until Resume.
- **Pending cards do not hold it.** A target waiting on an approval card or a
  question still gets the occurrence as a new turn, like a queued or peer
  prompt. The card stays pending.
- **Archived and settled targets** are unarchived and unsettled at the final
  admission check, then delivered; the restore must succeed before the append,
  or the occurrence is not delivered. This differs from peer prompts on purpose:
  a weekly session the user settles is auto-archived after seven days.
- **Deleted targets** delete the Schedules that target them.
- **Never human intervention.** An occurrence does not close peer chains, does
  not reset the hop count, does not lift a Stop, and spends no hop.
- The pending runtime selection applies at admission, as for every other turn
  origin (`session-runtime-switching.md`).

### What the agent sees

The transcript entry is a user-role entry with
`origin: { kind: "schedule", scheduleId, occurrenceId, dueAtMs }`, rendered with
a ⏰ label that links to the Schedule. The model reads a header line before the
prompt:

> ⏰ Scheduled prompt "PR CI check" · schedule `sch_12` · due Wed 25 Nov 15:45
> Europe/Berlin

For a new-session target the header also links the session the previous
occurrence started, so the agent can read it with `session_read`.

## Who may change what

The user changes any Schedule directly in the UI; no card. When the user edits
an agent-controlled Schedule, `controlledBy` becomes the user and `createdBy`
stays as history.

- **The user's writes** are an edit (prompt, timing, existing-session target),
  on/off, delete and Pause all: cardless, with no cardless limit. An edit and an
  on/off both make the user the controller, an on/off even when the enabled
  state does not change; a switch to the state the Schedule already has, with
  the user already in control, writes nothing. Only the fields the user changed
  travel, and the last write wins: there is no revision precondition.
- **The zone** is fixed at creation and is never edited: an edit's timing
  carries no zone and takes the stored one.
- **A user target** is any session the user can see, archived included, except
  the Personal Assistant singleton. An unchanged target is not checked again.

A **near target** is the agent's own session or a direct child it still owns: a
`spawned` edge from the agent AND the child still coordinator-owned. A child the
user has taken over is not a near target, though the edge remains.

Authorization is evaluated at the write, against the Schedule as stored then, by
the first matching row:

| Agent action                                                                                                                                                  | Approval                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Create a new-session Schedule, change a Schedule's target to a new session, or change the prompt, target or runtime of a new-session Schedule                 | card, always                    |
| Create an existing-session Schedule for a near target, or change, enable, disable or delete one this session controls whose target is and stays a near target | none, within the cardless limit |
| Anything else: other targets (grandchildren included), and any change, enabling, disabling or deletion of a Schedule this session does not control            | card, or the `schedule` grant   |

The near-target row never overrides `controlledBy` or the card-always row.

- **Cardless limit:** a session may control at most 10 Schedules it created
  without a card (setting), disabled ones included; `done` ones do not count.
  Card-approved and user-controlled Schedules do not count. The limit is checked
  on every change that makes a Schedule count (a create, or an update or enable
  that makes a `done` one active again), never on a change that adds nothing, so
  a lowered limit never blocks edits, disabling or deleting.
- **The card** shows name, prompt, timing with the next three occurrences,
  target and, for new sessions, agent, Project, account, model and effort. An
  update shows a diff. The prompt, timing and runtime are editable on the card;
  the runtime editor and its approval-time validation are the `sessionSpawn`
  card's (`prepareSpawnApproval`). Approval refuses a `once` time already in the
  past and leaves the card pending so the user can fix it; a repeating Schedule
  starts from its next future occurrence.
- **One card per call.** `schedule_manage` takes several operations and proposes
  them together.
- **The `schedule` grant key** covers the "card, or the grant" rows and never
  the "card, always" rows: those decide what an unattended new session runs, and
  the card is where the user checks that.
- An approved card makes the Schedule user-controlled.

## Agent tools

Both deferred, for the developer, assistant and personal-assistant personas; not
for workshop or workflow coordinators. Plan mode keeps `schedule_read` and drops
`schedule_manage`.

- **`schedule_read`:** list and get, filtered by target session, creator
  (`"user"` or a session id) or state (`enabled`, `disabled`, `done`). Every
  Schedule is readable by every agent session. A list returns 50 by default and
  at most 100, with `count` (rows returned) and `truncated`; each row shows its
  next and last occurrence and the prompt clipped at 200 characters plus "…". By
  id it returns the full prompt, the next three occurrences and at most 50
  history entries, newest first; a history `error` is shown as stored.
- **`schedule_manage`:** create, update, enable, disable, delete, 1 to 20
  operations per call, applied in order; each operation is written whole or not
  at all and fails alone, and the call fails only when its input is malformed or
  every operation failed. Phase 1 writes only what needs no card (the
  near-target row above): a create targets this session or a near child, and is
  always created and controlled by this session and cardless; a change needs
  this session as controller and a target that is still near, and a new target
  must be near too. Nothing in an operation sets authority, cardlessness or a
  zone.
- **Timing input.** A row never names a zone: create uses the user's profile
  zone, update the Schedule's stored zone. `once` takes a local date-time
  (seconds round up to the minute; a skipped time keeps its wall time and occurs
  when the gap ends), an ISO time with offset or `Z`, or a relative time ("in
  45m", "in 2h", "in 1d", where 1d is 24 hours). The last two are instants,
  rounded up to the minute; one that lands on the second pass of a repeated hour
  is refused, since a Schedule occurs at the first. Every supplied timing, on
  create and on update, must have a future occurrence: a past `once`, a repeat
  whose `endsOn` has passed, or an expired timing equal to the stored one fails
  its operation with `Schedule timing has no future occurrence` before anything
  is written or cut over. An update without a timing keeps the rules above, so a
  Schedule whose timing runs out by itself still becomes `done`; an agent ends a
  Schedule by disabling or deleting it.
- **Echoes.** Every create, update, enable and disable result echoes the
  Schedule with up to three next occurrences, fewer when its timing runs out
  sooner, and `[]` when it is disabled or `done`. A delete result is exactly
  `{operation, ok, id, deleted}`. Every absolute time (echoes, `next`, history
  `due`, `claimed` and `ended`) is `formatScheduleInstant` in the Schedule's
  stored zone. The 500-character bound applies to delivery and history reasons
  only, not to an operation's validation error.

The tool description must say that Schedules are for wall-clock times and
`Monitor` is for conditions, and that a prompt must stand on its own: after
compaction the session that wrote it may no longer know why ("check CI for PR
#382 in pandeck; merge if green", not "check it").

## Web

- **Schedules page** (`/schedules`, a nav item): name, target, timing, next
  occurrence, last occurrence with its session, creator, on/off, delete, the
  Done filter and Pause all. A needs-attention count on the nav item counts
  Schedules whose last occurrence `failed`.
- **Detail** (`/schedules/:id`): editable prompt, timing and target, the
  new-session runtime, the next three occurrences, history.
- **Session inspector:** the session's Schedules with an on/off switch each. A
  session a Schedule started links back to it.
- **Session header:** a badge with the next occurrence, for repeating Schedules
  only.
- There is no create button and no "Send later" in the composer: Schedules are
  created through agents.
- Occurrences notify nothing of their own; the Sessions inbox signals as for any
  turn.

## Sync and storage

A new domain on state-change events from the start (`state-sync.md`): topic
`schedules`, summary upserts and deletes with revisions, digest resubscribe.
History is a request/response read, outside the live projection. The web always
subscribes; the inspector section and the header badge filter that state, so
`SessionListItem` gets no new field.

Tables `schedules` (definition, `next_due_at_ms`, `revision`),
`schedule_occurrences` and `schedule_pause` (Pause all, one row). Settings,
through the registry: grace window (60 minutes), cardless limit (10), Pause all.
Pause all is a registry field of the Schedules section, but the schedule store
keeps its value: the settings file holds only the other two, and the section
projects `paused` from the store.

The user's commands each carry a `requestId`. `updateSchedule` and
`setScheduleEnabled` answer their own connection with ONE authoritative
`scheduleSaved {item, revision, requestId}` before `mutationSettled`, a no-op
on/off included; `deleteSchedule` settles through `mutationSettled`, and the
tombstone event follows. A refusal is an error naming the Schedule (target
`{type: "schedule", id}`) and never settles. `setSchedulesPaused` merges
`paused` into the current stored Schedules section in the same synchronous step
that starts the save, so a grace window or limit saved meanwhile survives, and
settles only once that save has completed; a failed save is an error stamped
with the request alone, since a `{type: "schedule"}` target without an id names
the list failure. `getScheduleHistory` answers `scheduleHistory` with the 50
newest occurrences and the Schedule's revision, read in one step; `items: null`
once the Schedule is gone, `error` for a failed read.

### Implemented so far

Phase 1 lands in two pull requests ([Task-1502](pa://task/1502), then
[Task-1503](pa://task/1503)). Agents create Schedules for existing sessions
through the tools; there is no UI, card, grant, link or new-session target yet.

- `app/shared/schedules.ts`: the model and `nextOccurrencesAfter`.
- Migration `0108_schedule_pause.sql`: Pause all as one row with no seed. SQLite
  is its only source: the first read creates the row unpaused, and the settings
  file is never read for it. A `schedules.paused` key left in the file by an
  earlier build of this branch is ignored and dropped by the next save of the
  section.
- Migration `0107_schedules.sql`. A Schedule's target is an open union
  (`target_kind`, with `target_session_id` for an existing session), so the
  new-session target adds columns rather than a table rebuild. The zone lives in
  the timing; an occurrence freezes its own copy with the prompt, name and
  target.
- `app/server/src/db/scheduleStore.ts`. Every public write is one transaction
  that moves the revision of each Schedule it touched, occurrence changes
  included. `claimDue` settles one Schedule's due times up to now in one
  transaction: it claims the latest when the stored Pause all is off and it is
  within the grace window, records the others `missed`, supersedes an earlier
  claim and advances `next_due_at_ms`; the unique `(schedule_id, due_at_ms)`
  makes a repeat insert nothing. `setPaused` is the Pause all switch (Late and
  missed). `onClaimed` tells listeners about each claim, a switch's included,
  once and only after it committed; when the topic hand-off throws after commit,
  the listeners still hear the committed claims before the error throws.
  Settling, superseding and withdrawing move only a row still `claimed`, so a
  repeated or late settle changes nothing. A delete removes the history and
  leaves a tombstone with the delete's revision; the maintenance sweep marks
  `done` a Schedule whose timing ran out while disabled, prunes history, deletes
  Schedules 30 days after `done` and Schedules whose target session was deleted,
  and purges tombstones after 30 days.
- The `schedules` topic (`app/server/src/schedules/scheduleTopic.ts`): every
  write stamps through a change set, a live Schedule (`done` included) is a
  member, a tombstone leaves as a delete at its delete's revision. Every web
  connection holds it and diffs a digest on resubscribe; nothing renders it.
- The `schedules` Settings section, rendered from its three registry fields. A
  save with `paused` writes the file first, then switches Pause all through
  `setPaused`; reading the settings opens the database, since `paused` comes
  from it.
- The schedule clock (`app/server/src/schedules/scheduleClock.ts`), started
  after the boot's delivery recoveries and stopped at shutdown. It claims due
  occurrences with the grace window from the settings (the store applies Pause
  all), and runs the maintenance sweep on its own deadline. While started it
  hears every claim through `onClaimed`, its own and a Pause all switch's, and
  runs its `claimed` hook once per claim with the target from the occurrence's
  frozen copy. The hook is a wake, not a durable event: a claim committed while
  the clock is stopped stays owed and is not replayed at start. It wakes the
  scheduled prompts lane for that target.
- Deleting a session deletes the Schedules that target it; the boot sweep
  catches those whose target was deleted while the server was down.

- The scheduled prompts lane and its recovery
  (`app/server/src/schedules/scheduledPrompts.ts`, the lane in
  `sessionDeliveryLanes.ts`), as "Delivering into an existing session" and
  "Admission and crash safety" describe. Each turn admits one occurrence, the
  oldest first. The model-only header line collapses and trims the name's
  whitespace and gives the due time in the occurrence's frozen zone; the durable
  transcript entry holds the raw prompt with `origin: { kind: "schedule", … }`.
  Boot recovery runs after the peer-prompt recovery offers and before the clock
  starts.
- The `schedule` origin, labelled plain "Scheduled prompt" in the transcript,
  with no ⏰ label or link until the Schedules page exists (Phase 2).
- A failed `schedules` snapshot or digest read answers its own collection error
  (`Failed to list Schedules: …`, target `{type: "schedule"}`) and later topics
  still answer; the web holds it without rendering it until Phase 2.
- The agent tools (`app/server/src/tools/schedules/`), as "Agent tools"
  describes, for existing-session near targets only.

Phase 2 ([Task-1500](pa://task/1500)) is in progress, server side only so far:

- The user's commands (`app/server/src/schedules/scheduleUserCommands.ts`) and
  their messages, as "Who may change what" and "Sync and storage" describe. The
  store's `setEnabled` takes the new controller and moves it in the same
  transaction as the switch, or alone when the enabled state stays.
- `pa://schedule/<id>` links, routed to `/schedules/<id>` and resolved to the
  Schedule's name.
- `scheduleTimingFutureError` in `app/shared/schedules.ts`: the one
  future-occurrence rule the tools, the user's commands and the editor share.

## Phases

1. **Engine** ([Task-1499](pa://task/1499)), in two pull requests:
   - [Task-1502](pa://task/1502): model and `nextOccurrencesAfter` with DST
     tests, migration, store, the `schedules` topic wired into the web state
     engine without visible surfaces (a protocol change lands across shared,
     server and web together, root `CLAUDE.md`), the Settings section, the
     schedule clock with Pause all and retention. Inert.
   - [Task-1503](pa://task/1503): the scheduled prompts lane with crash
     recovery, the `schedule` origin with a plain "Scheduled prompt" label, and
     the tools for near targets.
2. **UI** ([Task-1500](pa://task/1500)): Schedules page, detail editor,
   inspector, header badge, transcript label, needs-attention badge.
3. **New sessions and the card** ([Task-1501](pa://task/1501)): new-session
   target, `scheduleChange` card and `schedule` grant, other-session targets,
   previous-occurrence link.

## Deferred

- Repeats more often than daily.
- Placeholders, attachments and `/skill` commands in prompts.
- Creating Schedules in the UI, and "Send later" in the composer.
- An overlap check between occurrences.
- A time zone that follows the user's profile.
- A failure signal beyond the needs-attention badge.
