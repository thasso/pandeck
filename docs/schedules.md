# Schedules

A Schedule sends a prompt at a wall-clock time, once or repeating, either into
an existing session or as the first prompt of a new session. The user and agents
both create them; the user sees and controls every one.

This contract was agreed on 2026-11-25 ([Task-1498](pa://task/1498)). Nothing in
it is implemented yet; the phases at the end say what lands when. The motivating
stories:

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
- An enterprise requirement is frozen when the Schedule is created, the way
  `buildSpawnProposal` freezes it for spawns: if the proposing session requires
  an enterprise account, every session the Schedule starts does too.
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
or drift. Every Schedule write and boot re-arms it.

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
  resume; the grace window covers server downtime only.

### States

`claimed` → `delivered` (existing session) or `started` (new session), or
`superseded`, `withdrawn`, `failed`, `missed`. Each row records the due time,
the claim time, the target session and any error.

- **One undelivered occurrence per Schedule.** A newer claim for the same
  Schedule supersedes an undelivered earlier one. The survivor is delivered when
  the session can take it, with no expiry; its header shows the original due
  time.
- **Disabling or deleting** a Schedule withdraws its undelivered occurrence.
- **Crash safety.** An existing-session occurrence is durable once claimed: the
  lane owes it. A new-session occurrence gets its session id at claim time, so a
  retry after a crash finds the session if it was already created instead of
  starting a second one.

### Overlap

No overlap check. An occurrence fires even when the previous one's session is
still running or waiting on the user: an existing-session target queues it
behind the running turn, and a new-session target starts another session.
Telling a stale previous occurrence from the user's own ongoing conversation is
not reliable.

### Retention

A Schedule keeps its last 50 occurrences; older rows are pruned. A `once`
Schedule becomes `done` after its occurrence, leaves the default list for the
Done filter, and is deleted with its history 30 days later. Deleting a Schedule
deletes its history.

## Delivering into an existing session

The `scheduled prompts` lane in `app/server/src/sessionDeliveryLanes.ts` sits
after the peer lanes and before background completions.
`mayJoinRunningTurn: false`: an occurrence never steers into a running turn; it
waits for the turn to end and is the next turn. It does not use the user's
prompt queue, which can be paused or held and whose rows count as the user
typing.

- **Stop holds it.** An occurrence is an automatic turn
  (`steering-and-queueing.md`, "Stop holds automatic turns"). On a Stopped
  session it waits as the Schedule's one undelivered occurrence until Resume.
- **Pending cards do not hold it.** A target waiting on an approval card or a
  question still gets the occurrence as a new turn, like a queued or peer
  prompt. The card stays pending.
- **Archived and settled targets** are unarchived and unsettled, then delivered.
  This differs from peer prompts on purpose: a weekly session the user settles
  is auto-archived after seven days.
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

An agent session needs no card to create, change, enable, disable or delete a
Schedule it controls whose target is its own session or a session it spawned
directly. Everything else is a `scheduleChange` card:

| Agent action                                                                     | Approval                        |
| -------------------------------------------------------------------------------- | ------------------------------- |
| Target its own session or a direct child                                         | none, within the cardless limit |
| Target any other session (grandchildren included)                                | card, or the `schedule` grant   |
| Enable, disable or delete a Schedule it does not control                         | card, or the `schedule` grant   |
| Change the timing of a Schedule it does not control                              | card, or the `schedule` grant   |
| Create a new-session Schedule                                                    | card, always                    |
| Change the prompt, target or runtime of a new-session Schedule                   | card, always                    |
| Change the prompt or session of an existing-session Schedule it does not control | card, or the `schedule` grant   |

- **Cardless limit:** a session may control at most 10 active Schedules it
  created without a card (setting). Card-approved and user-controlled Schedules
  do not count.
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

Both deferred, for the developer and assistant personas.

- **`schedule_read`:** list and get, filtered by target session, creator or
  state; includes history. Every Schedule is readable by every agent session.
- **`schedule_manage`:** create, update, enable, disable, delete, in batches.
  Timing accepts a local date-time in the user's zone, an ISO time with offset,
  or a relative time ("in 45m"). Every result echoes the absolute local time and
  the next three occurrences.

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

Tables `schedules` (definition, `next_due_at_ms`, `revision`) and
`schedule_occurrences`. Settings, through the registry: grace window (60
minutes), cardless limit (10), Pause all.

## Phases

1. **Engine** ([Task-1499](pa://task/1499)): model and `nextOccurrencesAfter`
   with DST tests, migration, schedule clock, the scheduled prompts lane, Pause
   all, the tools for the own session and direct children, this document.
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
