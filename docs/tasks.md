# Task contract

A Task is the USER's durable object. Agents read Tasks, may fold a decision into
one, and may suggest a status — they do not use the backlog to keep track of the
work they are doing right now, because the app deliberately gives them no place
to do that.

This document exists so that boundary stops being re-derived. It is the product
contract for Tasks; the module detail lives in `docs/reference/server-tools.md`
(the Task tools), `docs/reference/server-modules.md` (`tasks.ts`), and
`docs/reference/shared-protocol.md` (the wire shapes) — those describe the code
and carry no rule of their own. The wire-level rule this contract turns on lives
in `app/shared/CLAUDE.md`; the rules agents must follow when acting on a Task
live in the Task tools' own `description` and schema prose, which every harness
renders — never in a harness-specific prompt layer.

## What a Task is

A Task is one commitment the user keeps: something they intend to happen, worth
seeing again tomorrow. It carries a title, a Markdown description that is the
durable statement of the work, a status, a priority, an optional parent (subtask
edges form epics), an optional project, Jira keys, GitHub issue links and
external source links, and two independent dates.

An external link records which provider it points at (`slack`, `jira`, `github`,
`forgejo`, `unknown`), inferred from the URL when the writer omits it. Only
`forgejo` depends on configuration: it is self-hosted, so a link is classified
against the instance base URL in Settings → Forgejo — host, port and base path,
so an instance at `http://localhost:3000` does not claim every `localhost` link.
Until an instance is configured such a link reads as `unknown`, and that is not
a permanent verdict: an `unknown` source is re-detected on every read, so links
stored before the instance was configured become `forgejo` by themselves.

GitHub issue links (`githubIssues`) are the Jira keys' counterpart for GitHub:
canonical `owner/repo#123` refs (`normalizeGithubIssueRef` in the shared
package, which also accepts the issue or pull-request URL), stored as `github`
edges. The inspector shows each ref with its live title and state from
`GET /api/github/issues`, and commit and pull-request agents see them in the
Task context. `task_manage` refuses a malformed ref instead of dropping it. They
play no part in naming.

Jira keys are ordered. The first explicitly linked key is the Task's primary
naming reference. New Task-started session titles use that exact uppercase key,
and new Task-owned branches and worktree folders use its lowercase form. With no
Jira key they use `Task-<id>` for a session and `t<id>` for Git. Code adds these
prefixes after the no-tool naming agents produce the descriptive title or
suffix, so model failure or noncompliance cannot drop them. The choice is frozen
when each object is created; changing Task links never renames an existing
session, branch, or folder.

The two dates are not interchangeable and an agent choosing wrongly is the
failure mode, so keep them apart:

- `dueDate` is the external DEADLINE — when the world needs it.
- `scheduledFor` is the day the user plans to WORK on it. This is the field to
  set when asked to plan a day or pick what to work on.

Neither is a today/tomorrow flag. Both are real dates, so a plan that has come
and gone reports itself as unfinished instead of silently staying "today".

The dates, priority, project and issue links are the user's metadata, so an
agent sets them only from explicit instruction or strong evidence and asks
before an ambiguous bulk change. A guessed deadline is worse than an absent one:
it looks like a commitment the user made.

A Task is NOT an execution step, a checklist for the current session, or a place
to narrate progress.

## A subtask's project follows its parent

**A subtask lives in its parent's project. That is an invariant, not a
default.** When it was decided (2026-07-31), 145 of 145 unarchived subtask edges
in the real backlog had the child carrying exactly its parent's project — no
subtask has ever legitimately belonged to a different one. The eight subtasks of
Task 260 were agent-created with no project at all and had to be moved by hand,
which is the failure this rule removes: the agent no longer has to remember a
field.

It is enforced at the ONE seam every write path shares, `taskStore.setParent` /
`setProject` — agent create, UI save, an update that reparents, and the Backlog
drag, which reaches `reorderTasks` without ever passing through
`applyRelations`. A create-time default would have covered only the first two.

- Creating with a `parentId` and no `projectId` inherits the parent's project; a
  project stated in the same write wins, because `applyRelations` applies the
  parent first.
- MOVING under a parent that has a project takes the moved node and its whole
  subtree with it. Re-stating the same parent is not a move.
- Assigning a project cascades DOWN the subtree, so fixing an epic fixes its
  tree. There is no upward cascade: a project on one subtask says nothing about
  its epic or its siblings.
- Reparenting to the root, or under a parent with no project, leaves the project
  alone, and clearing one clears only that node. Neither destroys information.
- The escape hatch stays explicit: `projectId: ""`/null is honoured, so a
  deliberately unset subtask is possible. It survives saves on the subtask
  itself and saves that re-state its parent, but NOT the next assignment of a
  project on an ancestor — the cascade re-fills it even when the ancestor
  already had that project, because a cascade that stopped at the first
  already-correct node would leave a deeper mismatch unfixed. An unset that has
  to hold is a subtask parked at the root.

`projectId` stays STORED rather than derived from the root, so list filters,
`taskSummaryOf` and the wire model are untouched. Nothing else is inherited —
not Jira keys, not GitHub issues, not external links.

## Where a piece of work belongs

| The thing in front of you                                                     | Where it goes                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A commitment that will not be finished in this session                        | A new Task — it lands in the user's Inbox, untriaged               |
| A decision, constraint, or scope change a later reader of this work needs     | Fold it into the Task's description as a targeted edit             |
| The steps of the work in flight — the plan, progress so far, what is next     | Nowhere. Reply text and the streamed tool activity already show it |
| Durable long-form material: research, a brief, a plan, a reference            | A Knowledge Base file (`kb_write`), linked from the Task           |
| A short atomic preference, fact, or constraint the user asked you to remember | Memory (`memory_manage`), not a Task and not a KB file             |
| Review remarks on a code change                                               | Worktree comments (`review_comment_*`), never the Task trace       |
| Bookkeeping about your own tool calls, retries, or intentions                 | Nowhere                                                            |

When two of these look plausible, prefer the cheaper one, and prefer silence
over a record nobody asked for. The description is where meaning accumulates; a
new Task is a claim on the user's future attention.

## Who owns status

Status is OBSERVED, not reported (`224be3de`). The rules follow from that:

- Starting a session from a Task nudges it `todo → doing` server-side
  (`connection.ts` `linkTaskStart`). No agent needs to write that, and no agent
  should.
- The Backlog's "working" signal is derived from linked streaming sessions
  (`app/web/src/lib/taskActivity.ts`), not from the status field, precisely
  because the field goes stale.
- A Task's status is the user's call. An agent writing `done` or `todo` records
  a SUGGESTION instead (`tasks.ts` `resolveStatusWrite`); the Task keeps its
  real status until the user answers, and an ordinary save never silently
  discards a pending suggestion. Those are the only two suggestible values.
- A `done` suggestion ALSO takes the Task out of `doing`, into `todo`. Both
  halves of "I finished, and I am no longer working on it" are true at once, so
  a closeout says them in one call and never needs a corrective second write.
- Nothing auto-reverts `doing` otherwise. Saying nothing means "leave it in
  doing", which is the truth when work is paused mid-flight, so a `todo`
  suggestion moves nothing by itself — it is for genuinely handing work back.
- The escape hatch is explicit rather than implicit: when the user asked for a
  status in this session, an agent writes it with `userRequestedStatus` — the
  status is applied AND the claim recorded, with agent provenance, so it reads
  as "done at your request" and stays visible and reversible.
- A suggestion is answered wherever it is READ: the Backlog's Focus row and the
  transcript card for the mutation that recorded it
  (`acceptStatusSuggestionSave` builds the save for both). Answering is an
  ordinary user save and never resumes a session, and it carries no title —
  confirming a status is not a rename, and the transcript's copy of the title is
  as old as the mutation.

## What a Task-attached session is given

**The injected Task context is AUTHORITATIVE: a Task-attached session makes zero
Task calls before doing real work.** The attachment bytes ride the first user
message and are cached for the session, while a `task_read` reprocesses the
whole conversation — so anything an agent needs at the start belongs inline, and
the attachment says so instead of asking to be re-read.

- It is built AFTER `linkTaskStart`, from the `TaskItem` that call returns
  (`connection.ts` → `taskContext.ts`). Building it from a pre-nudge read is
  what used to open a session on a stale `Status: todo`; the injected status may
  never contradict the stored one.
- It carries the Task's title/status/description, the parent's title and a
  clipped description, and the grandparent's title as a breadcrumb. No siblings
  and no subtree — those are a `task_read` away, and so is a parent's full body.
- The WHOLE attachment is budgeted (~8 KB) and spent in that priority order,
  because parents are epics and epics are the long bodies: injecting a parent in
  full systematically injects the worst case. Only the Task's own description is
  never clipped — it is the point — so a very long one may carry the total past
  the budget and displaces the material below it. Whatever is dropped says so.
- Attaching a Task on ANY prompt is a supported shape, not just on the first
  one: the web client only offers it before the first user prompt, and the
  server does not enforce that. The attachment is therefore worded "current as
  of the moment the Task was attached", and the zero-calls rule is "before doing
  real work" rather than "at session start".
- Truncation has ONE vocabulary app-wide: the marker in `textBudget.ts`, shared
  with the bounded `task_read` payload. A second marker format would make the
  same signal something an agent has to learn twice.

## When an agent may create a Task

Only for genuinely new work that will NOT happen in this session. A Task created
to represent a step of the work in flight is the failure this contract forbids.

Every agent-created Task arrives in the Inbox untriaged (`tasks.ts` `createTask`
defaults to untriaged; `triagedAt` is set only by an explicit user act). There
is no exception for "the user asked me to file it" — triage is the user's act of
processing an arrival, and no tool sets it. Write the title and description so
the user can decide about it later without asking what it meant.

## Tasks carry no comments

A Task has no comment trace: no tool writes one, no read returns one, and the
Task page shows none. What a comment used to record goes elsewhere — a decision
into the description, a follow-up into its own Task, review remarks onto the
worktree, and progress nowhere.

The `task_comments` table (migration `0020`) and its existing rows are kept,
untouched, in the user's database. Only the historical audit
(`pnpm run measure:tasks`) still reads them; exporting or deleting them is the
user's decision and needs its own migration.

## Who may rewrite a description

The description is the durable statement of the work and the user's text. An
agent may FOLD something into it; it may not replace it.

- A whole-description write is refused for an agent on update. The body changes
  only through targeted `descriptionEdits` — exact `oldText`/`newText` pairs,
  each matching exactly once — so an agent cannot clobber a body it did not
  read, and a stale edit fails loudly instead of silently winning.
- `create` still writes a whole description: there is nothing there to lose.
- The user's own editing is untouched. This is a rule about agents, enforced
  where agents write.

## When a Task may be archived

Archiving takes a Task out of every list without deleting it. It is the ordinary
end of a finished Task, so it asks NO confirmation — the receipt carries
**Undo** instead (`archiveTask` with `archived: false`), which is also the only
way back: the app ships no archived-Tasks view, so an archive nobody can undo is
a Task nobody can find.

The default Backlog retains completed work for 14 days, then the server archives
it automatically. A done subtask is held while its DIRECT parent is still
active, so a finished step does not vanish from an unfinished epic; it becomes
eligible once that parent is done or archived. Root Tasks and children of done
or archived parents need no second fetch path: the sweep runs at boot, hourly,
and after Task writes, and archives through the ordinary mutation seam so every
subscriber converges. Every invocation is best-effort and logged: retention is
retried later rather than turning an already-durable user write into a false
failure or taking down the server. This retention lifecycle is separate from the
USER archive checks below: those govern an immediate deliberate gesture, not
aging an already observed completion out of the default list.

**An archive takes a Task's FINISHED subtasks with it.** A subtask is not
separate work, and hiding an epic alone strands its finished children: the
Backlog promotes a child whose parent vanished to the root, where it has lost
the epic that explained it. So the archive SET is the requested rows plus every
done descendant (`archiveSet` in `app/web/src/lib/taskArchive.ts`), it is what
the receipt counts, and Undo restores exactly it — no parent edge is ever
touched, only `archivedAt`, so restoring brings the hierarchy back intact. The
set and the rules below belong to the USER's archive paths; an agent's
`task_manage` archive stays the one row it names, so the Backlog may still show
a child promoted to the root — the edge survives it (see the reorder rule at the
end of this section).

**Being marked done is not on its own a licence to archive**, and the cascade
never reaches UNFINISHED descendants. Three conditions refuse an archive, on
every path (`lib/taskArchive.ts`, evaluated for all Task surfaces) and asked of
the whole set rather than of the row the user touched:

- **Open subtasks.** Any descendant that is neither done nor already archived,
  and not itself part of the set. Archiving an epic together with its unfinished
  subtasks is therefore allowed while archiving just its head is not, and the
  refusal offers exactly that as its escape hatch ("Archive all N", the whole
  subtree), because an abandoned epic must not become a Task the user can never
  get out of their list. Taking work nobody finished has to be ASKED for.
- **An unanswered status suggestion.** A Task that is `done` only because an
  agent said so is carrying a QUESTION, and the Focus view is the only surface
  that can answer one. Archiving would delete the question with the row — a
  subtask's claim included, since the cascade would take that row too rather
  than leave it visible at the root.
- **A session running right now**, observed from the Task's linked sessions
  (`lib/taskActivity.ts`), never from the status field.

The QUICK archive — the phone's RIGHTWARD swipe and the row's pointer button —
is narrower still: it is offered only on a `done` Task whose whole set passes
all three. A Task you have not finished can still be archived deliberately (the
tree's `e` key, the Task inspector) because deciding not to do something is a
real decision, but it is not something a thumb does in passing. A gesture cannot
explain a refusal, so a row that would refuse does not slide at all; the
deliberate paths refuse out loud, with the reason.

**Deleting a Task takes its whole subtree, and always asks first.** `deleteTask`
on the server removes ONE Task and promotes its children to roots, so a client
that deletes an epic alone does not remove its subtasks — it scatters them
across the top level, detached from the Task that explained them and with no
Undo to bring the parent back. Every delete path therefore sends the subtree,
deepest first (`lib/taskDelete.ts`), so nothing is ever momentarily drawn as a
root on its way out.

Unlike the archive cascade this takes UNFINISHED descendants too. The archive
can afford to refuse them because the parent survives one Undo away; a delete
has nothing to leave them attached to. What replaces that guardrail is the
CONFIRMATION, which is why it names the count ("This also deletes 3 subtasks") —
agreeing to delete one row is not agreeing to delete four, and this is the last
moment at which the difference can be declined. The phone's LEFTWARD swipe is a
delete like any other: it opens that question, the row springs home behind it,
and nothing leaves the list until the answer is yes.

**A reorder never detaches a child from an archived parent.** A client cannot
see archived rows, so it draws such a child at the root and sends it back as a
root placement; `reorderTasks` keeps the existing edge in that one case
(`app/server/src/tasks.ts`). Otherwise the next drag anywhere in the Backlog
would make the promotion permanent, and an epic restored later would come back
without its subtasks. Only a placement naming a parent moves such a child.

## The Backlog's order is the user's

**A Task's place in the Backlog tree is decided when it JOINS a sibling group,
and after that only a drag moves it.** The tree view is the hand-arranged one:
you look down it and start working, so a row that moves for a reason the list
never showed you costs you the place you had found. Nothing MUTABLE may decide a
row's position — not status, not a date, not a project, not `updatedAt`.

- Every Task is created with a `sortOrder` (`taskStore.nextSortOrder`). A Task
  joining the ROOT lands above what is already there, because an arrival has to
  be seen; a Task joining a PARENT is appended after its siblings, because a
  parent's children are a plan and a plan reads top-down.
- Anything else that moves a Task between groups asks for a free position the
  same way: a reparent that states none, and a Task coming back from the
  archive, which left holding an index the Backlog has since given away.
- A drag renumbers the groups it touched from the order on screen, so every row
  the user did not move keeps its place — including rows a filter was hiding
  (`reorderPlacements` re-applies the move to the FULL tree).
- Stating a position explicitly stays possible (`task_manage`'s `sortOrder`),
  and it moves that one Task, never its siblings.
- Ordering is one client-side function, `compareTaskOrder`
  (`app/web/src/lib/backlogTree.ts`), which every tree surface goes through. Its
  tie-break is `createdAt` then id: legacy rows created before positions were
  assigned on arrival still sort deterministically.

## Tasks are not workflow execution state

**Decision: provider-native todo lists and the user's Task backlog are not an
agent's execution scratchpad. A first-class Workflow Run is the separate object
for durable multi-session orchestration.**

- `TodoWrite`/`TodoRead` stay disallowed in every Claude session: they are
  absent from `CLAUDE_SDK_NATIVE_TOOLS` and present in
  `KNOWN_CLAUDE_NATIVE_TOOLS` (`app/server/src/claudeSdk/options.ts`), which is
  filtered into `disallowedTools`. The one-shot helper paths disallow every
  native tool. Pi has no todo tool to disallow.
- Agents do not create Tasks or provider-native todo items to track steps they
  intend to finish as part of the work already in flight.
- A Workflow Run is user-started, linked to the Task, and owns its durable
  execution steps, structured results, decisions, and recovery state. It does
  not change what a Task means or who owns Task status.
- Workflow state is advanced by the deterministic runtime and structured agent
  results, not by an agent maintaining a prose checklist.
- The agreed but not-yet-implemented architecture is `docs/agent-workflows.md`.
  Until it ships, agents continue to plan in reply text and the session view
  continues to show tool activity; the absence of a Workflow Run surface is not
  permission to use Tasks as a substitute.

## The audit behind the Task boundary

Measured 2026-07-31 against the user's live `DATA_DIR` (`app.sqlite3` and
per-session `native.jsonl`), read-only. The data keeps moving — the re-run
column is the same day, a few hours later, and grew because the epic's own
sessions add rows. The ratios are the point, not the absolute counts.

| Measure                                                       | Planning audit            | Re-run, same day                    |
| ------------------------------------------------------------- | ------------------------- | ----------------------------------- |
| Tasks, total / agent-created                                  | 289 / 245 (85%)           | 299 / 255 (85%)                     |
| Median agent-created lifetime create→done                     | 155 min (41 under 30 min) | 157 min, n=176 (41 under 30 min)    |
| Median user-created lifetime create→done                      | ~15 days                  | 10.8 days, n=8                      |
| Comments, total / authored by the user                        | 158 / 0                   | 164 / 0                             |
| Tasks with exactly one comment                                | 43                        | 45                                  |
| Commented Tasks with comments from >1 session                 | 12 of 68                  | 13 of 71                            |
| Status events, agent / user                                   | 84 / 77                   | 84 / 81 (+6 system)                 |
| Agent corrective `doing → todo` writes                        | 5                         | 5                                   |
| `TodoWrite`/`TodoRead` tool calls, ever                       | 0                         | 0 (across 122 `native.jsonl` files) |
| Task tool calls: `task_read` / `task_manage` / `task_comment` | not broken out            | 234 / 213 / 112                     |

(`task_comment` no longer exists; its 112 calls are the round trips
[Task-294](pa://task/294) folded into `task_manage`.)

Three derived numbers drove the shape of the fix:

- **~5 Task provider calls per Task-attached coding session** — read → `doing` →
  comment → `done` → corrective `todo` — which was ≈12% of the 41 provider calls
  in the session that motivated the epic. Target: one call at closeout, zero
  when nothing durable happened.
- **Eager Task tool cost.** Planning recorded 7,357 B per session. Re-measured
  with the `promptInventory` accounting (wire name + `description` +
  `JSON.stringify(parameters)`, plus — while they still existed — the pi-only
  `promptSnippet`/`promptGuidelines`, which the Claude CLI dropped into ignored
  `_meta`): **pi 7,102 chars, Claude 5,696 chars**. The pi/Claude split matters
  — the same three tools cost different amounts per harness, so a before/after
  must be reported per harness or a pi-only win will look like a Claude
  regression. The figure moves with every slice, so it is only meaningful
  measured immediately before and after one: [Task-293](pa://task/293) took it
  to pi 7,888 / Claude 6,260, and collapsing three tools into two
  ([Task-294](pa://task/294)) to **pi 7,749 / Claude 6,232**. That two-tool
  number is barely under the three-tool one, and the reason is worth recording:
  deleting `task_comment` frees only 584 pi / 346 Claude chars, while
  `descriptionEdits`'s nested array-of-objects schema costs about as much on its
  own. Folding tools together buys ROUND TRIPS, not bytes; the byte win has to
  come from shorter descriptions. Bounding `task_read` by bytes then spent some
  of it back — the `comments` object plus the two guidelines that explain the
  bound — for **pi 8,371 / Claude 6,626**, and making the injected context
  authoritative ([Task-296](pa://task/296)) added 80 pi chars qualifying one
  `task_manage` guideline, for **pi 8,451 / Claude 6,626**. A pi-only line is
  invisible to Claude, which is exactly why the split is reported. Folding the
  rules into the descriptions ([Task-298](pa://task/298)) then moved the two
  harnesses in OPPOSITE directions — **pi 7,094 / Claude 7,112** — because it
  deleted 1,843 chars pi rendered and added 486 chars of `description` both
  harnesses render. The pi side is the only one that ever saw the deleted text;
  paying ~120 tokens per Claude session to stop shipping Task rules only some pi
  sessions received is the trade that slice made deliberately. Today the two
  tools cost **pi 4,503 / Claude 4,521** — 39% under the planning baseline — but
  the drop from 7,094 is not this sub-epic's: [Task-285](pa://task/285) trimmed
  every eager tool's description and schema afterwards (`b3b4cadb`), where the
  two Task schemas alone fell 6,436 → 3,742 chars while their descriptions grew
  638 → 741. The line this sub-epic ended on is 7,094 / 7,112.
- **pi-only Task guidance**: 1,668 chars of `promptGuidelines` across 13 bullets
  plus 175 chars of `promptSnippet` in `taskTools.ts` at its peak, reaching only
  pi developer/workshop sessions (pi's `buildSystemPrompt` returns early on a
  custom prompt) and invisible to every Claude one. Now **zero**, and
  permanently so: [Task-282](pa://task/282) deleted both fields from `AgentTool`
  itself, so the type system forbids them and
  `tools/toolGuidanceSurface.test.ts` guards the channel from coming back.

## Re-running it, and what it measured

`pnpm run measure:tasks` ([Task-299](pa://task/299),
`app/server/src/taskOverhead.ts`) reproduces this whole audit — the storage
counters above, the per-session call and round-trip figures below, and the eager
byte figures — read-only against a live data dir:

```
DATA_DIR=/home/alice/assistant-data pnpm run measure:tasks           # markdown tables
DATA_DIR=/home/alice/assistant-data pnpm run measure:tasks -- --json  # every session, raw
```

**The unit is PROVIDER CALLS, not tool-output bytes.** A tool call cannot end a
turn, so it forces a continuation call that reprocesses the conversation; a turn
whose tool calls are ALL `task_*` is bookkeeping-only, and that continuation is
what it cost. A Task call batched into real tool work forces nothing extra and
is deliberately not charged — which is why the collapsed tool surface shows up
here as a win rather than as unchanged call counts.

Two limits are structural and the report states both rather than papering over
them. Only a source with per-call usage can resolve round trips: pi's
`native.jsonl` always can, a Claude session can when its CLI transcript under
`~/.claude/projects` still exists (about half of them), and the app's own
`claude-sdk/<id>.json` never can, because it collapses a whole turn into one
entry. Those sessions still contribute call counts, and every average names the
cohort it was computed over. And the windows are not a single instant: the
slices landed over one day, so sessions started between the first and the last
are reported as `transition` and excluded.

### The reduction (measured 2026-08-02)

Per Task-attached session, `before` = the 64 attached sessions preceding the
first slice, `after` = the 25 following the last one:

| Per Task-attached session             |  Before |          After |
| ------------------------------------- | ------: | -------------: |
| Task tool calls                       |    6.56 |    1.68 (−74%) |
| …excluding the removed workflow tools |    5.11 |    1.68 (−67%) |
| Task calls before any real work       |    1.74 |    0.36 (−79%) |
| Re-reads of the attached Task         |    1.14 |    0.40 (−65%) |
| Bookkeeping-only round trips          |    4.48 |    1.14 (−74%) |
| Processed input on them (tokens)      | 708,079 | 112,709 (−84%) |
| …new input, uncovered by a cache hit  |   9,435 |   3,190 (−66%) |

The 5.11 core calls per session is the "~5 per Task-attached coding session"
planning estimated, arrived at independently. The lifecycle collapses where the
epic aimed it: `start` 0.30 → 0, `handback` 0.06 → 0, `comment` 1.47 → 0.32,
`create` 0.92 → 0.04, while `read` only halves (2.13 → 1.20) because reading
OTHER Tasks is often the work itself — the number that isolates the regression
is the 1.14 → 0.40 re-read of the session's own attached Task.

Read the two token rows together. Processed input is what the round trip made
the provider walk; new input is what no cache hit covered, and it is ~1% of it.
A bookkeeping round trip is cheap per token and expensive per call, so the call
counts, not the token totals, are the result.

Three caveats, all visible in the output:

- **Small after-cohort**: 25 attached sessions, 14 of which resolve round trips.
  Re-run it as the sample grows; the command is the record, this table is a
  snapshot.
- **The workflow tools contaminate the before window.** 224 of the 1,119 before
  calls went to the Planner → Implementer → Reviewer family that
  [Task-264](pa://task/264) removed — a different change — so the row excluding
  them is the honest comparison.
- **`doing → todo` changed meaning at the boundary.** Before, an agent writing
  it was the corrective second call this epic removed (5 of them). After, the
  same event is the move a `done` suggestion makes on its own, so the two
  windows are reported apart and never summed.

One number the instrument reproduces exactly, which is the check on it: the
eager Task tool block at `c6c6f180` measures pi 7,094 / Claude 7,112, the figure
recorded above for that slice.

## Where the rules live

Every rule an agent must follow about Tasks is in `taskTools.ts` — the tool
`description` and the schema field prose — because that is the only surface both
harnesses render. Nothing about Tasks belongs in a persona prompt: a prompt that
also asks for a session plan or visible progress tracking contradicts this
contract, since the app gives an agent no tool for either.
