# Agent workflows — v1 architecture

**Status:** agreed v1 plan for [Task-363](pa://task/363). Persistence, the wire
model, recipe/engine foundation, run start, and agent execution are implemented
([Task-364](pa://task/364) through [Task-367](pa://task/367)). The first real
host operations are implemented too ([Task-368](pa://task/368),
[Task-596](pa://task/596)): `commit-sync`, `commit`, and `base-sync` reuse the
safe commit and worktree-sync services and produce checkpointed review ranges.
The review loop is proven end to end ([Task-369](pa://task/369)): implement →
commit/sync → review iterates on `revise` against the same role sessions,
bounded by the iteration limit, and continues through a server restart via boot
reconciliation. The Task now carries a live workflow card with role sessions,
reviewed-commit evidence, visible pause reasons, and user-owned
pause/resume/cancel/semantic-retry controls; Backlog rows carry the compact
run/attention indicator ([Task-370](pa://task/370)). The exact-head delivery
gate and retry-safe push/PR publication now compose with the existing live PR
card ([Task-371](pa://task/371)). Durable exact-head PR waits now reuse that
card's background observer across restarts: CI failures, hosted changes
requests, and base conflicts pause and notify, while green CI plus known-clean
hosted review and mergeability reaches a recorded user-decision step
([Task-372](pa://task/372), [Task-373](pa://task/373)). The existing merge
action records the choice, and a provider merge observed in-app, in the hosting
UI, or after restart completes the run. Terminal cards retain the PR/session
evidence, carry the merge and safe-cleanup controls themselves, and point to the
separate Task-completion choice. Workflow v1.1 adds a constrained Task-context
planner ([Task-374](pa://task/374)): it chooses a bounded model/work plan from
the user's role-scoped candidate sets. Task-506 makes fixer and post-fix verdict
first-class roles, with family and operator notes supplied as coordinator
evidence rather than enforced routing rules. Workflow v1.3 turns that role into
the run's **coordinator** ([Task-403](pa://task/403)): the number of review
passes is no longer planned upfront but decided after each passing review, in
the coordinator's own session, against the range's change evidence and the
reviewer's own words. Workflow v1.2 makes the review loop an exchange
([Task-392](pa://task/392)): findings and observations are separate, an
accepting verdict may no longer carry unaddressed findings, each role's
assignment carries the other's words, the implementer may answer a finding
instead of only obeying it, and the card shows the review the user previously
had to open a session to read. Workflow v1.4 closes the loop those revisions
left open, and is implemented in full: findings return to the agent that raised
them, the coordinator is asked after every assessment rather than only after a
passing one, no head reaches delivery without a passing discovery review that
names it, and an exhausted ceiling asks the user to raise it instead of
delivering work the run could not finish reviewing. Run 72
([Task-494](pa://task/494)) is the motivating failure: a `revise` was fixed by a
fixer that wrote more code than the implementation it was fixing, judged only by
the post-fix verdict, and delivered — so the larger half of the pull request
carried no discovery review at all, and the coordinator was asked nothing after
planning. This revision deliberately slims an earlier, broader proposal: it
keeps the persisted foundation that would be expensive to retrofit and defers
everything speculative. The deferred ideas are listed at the end with the reason
the v1 model does not block them.

## The problem

A repeated manual code workflow motivated this design:

1. Open a Task and start a developer session in a new worktree.
2. Ask the agent to implement the Task.
3. Start an independent review session on the same worktree.
4. Let reviewer and implementer iterate until the reviewer accepts.
5. Run `/pr`, observe CI, merge manually, and optionally clean up.

PA already owns the execution primitives: Task context, worktree provisioning,
durable sessions, host-driven commit/push/PR actions, the live PR card, CI
observation, merge actions, and safe worktree cleanup. The missing object is a
durable coordinator that knows what step comes next, what evidence exists for
which commit, and where the user must decide — across sessions, restarts, and
long external waits.

## What a Workflow Run is

A **Workflow Run** is one durable attempt to produce an outcome for a Task. It
is not any of the existing objects:

- A **Task** is the user's durable commitment. Its status remains the user's
  decision, and per `tasks.md` the Task never becomes an execution scratchpad:
  routine workflow transitions do not become Task comments.
- A **session** is one agent identity and transcript. A session may perform
  several sequential workflow steps, so session identity and step identity stay
  separate. A session created by a run is named deterministically before its
  first assignment. It starts with the Task's primary Jira key, or `Task-<id>`
  when none is linked, then `<role> — <Task title> · Run <run-id>`. It never
  invokes the ordinary session-naming agent. Reviewer names include their pass;
  fixer names include their review or verdict lineage when one exists. If the
  name is too long, only the Task-title segment is truncated, preserving the
  Task, role, and trailing run identity.
- A **worktree** is a mutable resource the run's steps operate in.
- A **pull request** is an external resource the run observes, not run state.

A Task may have multiple Workflow Runs, each with its own worktree, branch, and
sessions. V1 does not automate any interaction between them.

### Not every multi-agent shape is a Workflow Run

Three lanes coexist deliberately, and the difference is who is accountable for
the outcome:

- A **Workflow Run** is host-governed. The runtime owns the step graph, holds
  assignments, requires structured terminal results, and survives restarts.
  Choose it when the outcome must be reconstructable without reading anyone's
  transcript.
- **Peer sessions started with `session_spawn`** ([Task-553](pa://task/553),
  [Task-595](pa://task/595)) are the free-form lane. The initiating agent is the
  coordinator: it writes the roles as ordinary prose, spawns ordinary
  `scope = "user"` sessions on runtimes the user approved once in Settings, and
  drives the review/fix/re-review loop over peer prompts. There is no watchdog,
  no ownership registry, no result contract and no automatic report — the server
  durably records one `spawned` edge from coordinator to child before delivering
  the opening prompt, and tells each child which session to answer. Either side
  exposes that parentage as navigable **Spawned by** / **Spawned sessions** rows
  in the Session inspector, and the Sessions inbox folds a coordinator and the
  peers it still owns into ONE card (below). An idle child means nothing;
  chasing it is the coordinator's job. Choose it for experimentation, where a
  cheap wrong answer is recoverable.

  That spawn edge also carries WHO OWNS the child ([Task-637](pa://task/637)),
  as `SessionListItem.spawnOwnership`:

  - `coordinator` — created by `session_spawn` with ownership tracked from the
    start (or handed back by the user), and the coordinator runs it. Written
    before the opening peer prompt is delivered, so a child is never briefly
    unclassified. MESSAGING the child does not change this: the user pokes
    stalled peers all the time, and a poke leaves the coordinator in charge. The
    poked turn ends like any turn of a coordinator-owned peer — no top-level
    outcome or notification of its own; the user reads its answer in the peer
    itself or, while the coordinator is present, under its fold (a failure still
    surfaces there).
  - `taken-over` — the user EXPLICITLY took this child over: the Session
    inspector's **Take over** action (`setSpawnOwnership`). It records the state
    and one timestamp; taking over a child already taken over rewrites nothing.
    **Hand back** returns the child to `coordinator`, and a later Take over
    stamps afresh — but not to a coordinator that was deleted, since nobody
    would then run the peer. Only a non-deleted, user-scope session with a spawn
    edge can be set; anything else is refused. Edges marked before this rule,
    when any visible human prompt took a child over, keep their state.
  - `unknown` — a spawn edge from before ownership tracking, or metadata that
    cannot be classified. It fails closed: a consumer that folds
    coordinator-owned children under their coordinator must keep an `unknown`
    child directly reachable, and must not backfill it from a transcript.

  Re-linking the same coordinator/child pair is idempotent and cannot reset a
  takeover. The session list is broadcast only when ownership actually
  transitions. A session with no spawn edge cannot be taken over.

  The Sessions inbox is the first consumer of that edge
  ([Task-675](pa://task/675)): a coordinator and its `coordinator`-owned peers
  are one card stating bounded aggregate state, with the fold decided by the
  edge and its ownership alone, at any depth, with a cycle guard. A `taken-over`
  peer, an `unknown` one, and one whose spawner is archived or deleted stay
  top-level. A folded peer waiting on a human or holding an unresolved failure
  lifts the cluster, is named on it, opens in one action, and keeps the cluster
  visible even while the coordinator is settled. Settling the coordinator
  settles the folded peers with it, server-side through their current outcome
  revisions (`spawnClusterDescendantIds` is the one membership answer for both
  sides); a peer that is running, queued or waiting on a human refuses the whole
  Settle in its own wording, while a peer's failure never does. A
  coordinator-owned child's provider completion raises neither an outcome
  revision nor an OS notification; a failure after settlement unshelves it
  without a top-level revision so the cluster can surface it. A successful
  agent-driven coordinator wake is also intermediate while any peer reply it
  explicitly requested remains outstanding. That wake clears only the unread
  state it introduced, so the parent does not show **Done** while work is still
  coming; an older unread item remains. The coordinator raises its outcome after
  the final expected report; a direct human turn and a coordinator failure still
  raise their own outcomes while peers are active. `app/web/docs/ui-shell.md`
  owns the full contract.

  `session_control` gives the coordinator the matching runtime controls. Any
  session may cancel its own `queued` or `retryable_failed` peer prompts to a
  target, but it cannot retract a prompt once dispatch starts. A coordinator may
  stop a child only while the spawn edge remains `coordinator`-owned; takeover
  revokes that authority and handing back restores it. `stop` may clear the
  child's whole waiting queue before aborting the active turn, which prevents
  the running-to-idle hook from immediately starting the next queued prompt.
  Clearing another session's messages is allowed only through that owned-child
  stop operation. Stopping leaves the ordinary session and its transcript
  intact.

  The same `responseRequested` rows tell the user when a tree needs a poke: each
  session row lists the peers that still owe it a reply — the turn ended without
  the answer and nothing from that peer, nor on that request's chain, has
  reached it since — and a card whose whole tree has stopped while a reply is
  still owed shows **No reply from «peer»** (`app/web/docs/ui-shell.md`).

  ONE automatic signal exists, and only one. When the server RESTARTS while a
  delivered peer turn is still running, the sender of a prompt that asked for a
  reply is woken once with a notice naming the recipient session. This is not a
  report and not a retry: the prompt is never re-delivered (it is already in the
  recipient's log) and the notice carries no instruction. It exists because
  `interrupted` is terminal, so a coordinator holding `responseRequested` would
  otherwise wait for an answer that no longer exists — a silence
  indistinguishable from a child still working. A turn interrupted by a PROVIDER
  refusal (usage limit, overload, harness exit) is deliberately silent, because
  re-asking reproduces the refusal. The notice is exactly-once across restarts,
  and it narrows nothing else: an idle child still means nothing, and chasing
  one is still the coordinator's job.

- **Subagents** ([Task-457](pa://task/457)) are PA-owned delegates with their
  own registry and lifecycle. Neither lane above may import that domain, and a
  spawned peer never acquires its semantics.

## Foundation invariants

These hold in v1 and in every later extension:

1. Workflow state is persisted and deterministic; model prose is never the
   source of truth. An agent finishes a step by submitting a structured result,
   never by the runtime inferring an outcome from its transcript.
2. While a run is retained, step history is append-only: a revision or semantic
   retry appends new steps, completed steps and their results are immutable, and
   there is no mutable loop counter. The user may permanently delete a cancelled
   run as a separate cleanup action; that removes its entire history atomically.
3. Review evidence names the exact head commit it assessed and applies only to
   that commit.
4. A session executes at most one active step assignment at a time.
5. High-impact actions — merge, Task completion, worktree cleanup — remain user
   decisions.
6. External waits and recovery continue without an open browser, and restart
   behavior is idempotent or pauses as indeterminate.
7. Steps are stored generically (a kind plus a typed payload); the core model
   carries no field named after implementers, reviewers, Git, or pull requests.

## V1 architecture

### Recipe as code, steps as data

V1 ships one recipe — code delivery — implemented as ordinary TypeScript in the
server: a deterministic function that, given a run's persisted step history,
decides the next step or reports what the run is waiting on. There is no
declarative graph language, no definition snapshot, and no generic transition
interpreter. The run records the recipe's versioned identifier so a later
declarative engine can be introduced as a refactor of the decision function, not
a data migration.

Steps are persisted generically. V1 needs four step kinds:

- **Agent step** — one bounded assignment executed by a session, completed by a
  structured result. The runtime creates or reuses the session; the assignment
  context (objective, Task, prior results, commit range under review) is
  injected into the prompt. An assignment never steers a turn already running in
  that session — and a reused role session is routinely still finishing the turn
  its previous result was submitted from. It QUEUES behind that turn instead:
  the reservation stays pending until the session is idle, so the wait costs
  neither the assignment nor a new session. A queue that outlives the wait bound
  pauses the run with the reservation intact.
- **Host-operation step** — a registered deterministic operation calling
  existing application services through their seams: the commit workflow with
  its safety review, base sync/rebase, push, and PR creation/adoption. Never
  slash-command text, never an agent tool. Each operation declares an
  idempotency key reserved before side effects and whether a retry is safe,
  requires observation first, or must pause as indeterminate.
- **Wait step** — a durable subscription to an external condition (CI
  conclusion, PR mergeability, hosted review state), reconciled on boot.
- **User-decision step** — a deliberate human gate recording the allowed choices
  and the choice made.

Branching and loops live in the recipe code, which reads prior structured
results directly; there is no declarative gate-predicate language.

### Structured results

Agents complete work with a new generic **`session_submit_result`** tool: a
generic status (`completed`, `blocked`, `failed`), a bounded summary, and a
payload validated against the step's registered result contract. The server
infers run, step, and expected contract from the caller; the agent supplies no
workflow or step ids. The tool stays deferred for ordinary coding sessions, so
every workflow assignment explicitly tells its agent to load it through the
harness's tool search before submission. An idle session that never submits a
result is waiting or blocked per the step's timeout policy — never successful.

V1 registers a small set of typed contracts in code: agent-facing `work-plan`,
`implementation-result`, `assessment`, and `review-decision`, plus recipe-owned
operation evidence for commit ranges, the delivery gate, and PR publication. The
commit-range evidence carries a bounded description of what the range CONTAINS —
totals, a capped per-file stat, and the commit subjects — because the recipe is
pure and cannot look at a diff itself; that is what lets it hand the coordinator
real evidence at the review decision. An assessment carries a verdict (`pass`,
`revise`, `fail`) plus findings, and names the exact head commit it evaluated.
There is no user- or agent-supplied inline schema.

The two agent-facing contracts also carry the exchange between the roles, which
is otherwise impossible: an assessment separates ACTIONABLE `findings` from
non-blocking `observations`, and an `implementation-result` may carry
`responses` — one answer per finding the implementer did not simply fix. The
separation is enforced, not advisory: verdict and findings must agree, and a
submission where they do not is refused while the step still runs, so the
reviewer chooses between asking for a change and recording a remark. A `pass`
carries no findings, and a `revise` carries at least one. These are the only
cross-field rules in any contract, and both exist for the same reason: findings
are the only part of an assessment the recipe turns into a rework assignment, so
an "accepted, but…" verdict silently dropped everything it listed, and a rework
verdict whose substance sits only in the summary would ask for changes the
implementer is never told about.

Ordinary peer messaging (`session_send_prompt`) remains available for
clarification, but graph progress consumes structured results only.

### Review-report convention

`REVIEW_REPORT_CONVENTION` and `REVIEW_RESPONSE_CONVENTION` live once in
`app/shared/workflow.ts`. The workflow reviewer assignment receives the report
convention verbatim, and `/review` appends it to its staged draft only when that
draft is sent. The response convention — findings are claims, not orders —
reaches a fixer through the ONE server-owned handoff helper
(`worktrees/reviewHandoff.ts`), which the browser's comment handoff and the
workflow fix assignment both render; an assignment that carries that section
does not restate the convention beside it. Findings are structured
`{ severity, text, path?, line? }` evidence, rendered in severity order; the
constants set reporting discipline, while the assessment contract remains
authoritative for payload shape.

### Persistence

SQLite, three tables (migration `0036_workflow_runs.sql`, behind
`db/workflowStore.ts`):

- `workflow_runs` — Task and Project links, recipe id and version, worktree and
  branch, lifecycle (`active`, `paused`, `completed`, `cancelled`), two plain
  ceiling columns (fix iterations and discovery passes) holding the run's
  current ceilings and written again only by a recorded user decision, and the
  recipe-owned start configuration (`config_json`, migration 0037): opaque to
  the core, written once at creation, the captured input the agent executor
  builds each role's session from after any restart.
- `workflow_steps` — append-only rows: kind, typed payload, status, session or
  operation reference, structured result, retry/attempt count, and causal
  predecessor.
- `workflow_events` — append-only transitions with actor kind and id: step
  created/completed, result submitted, external conclusion observed, pause,
  resume, cancel, completion.

The maximum-sessions column is dropped: it was derivable from the two ceilings
and could contradict them. Existing runs lose that recorded number, which no
decision reads once sessions are derived.

Commit ranges, assessments, and PR identity live in step results as bounded
metadata and durable references (commit SHAs, session ids, PR numbers). Large
content stays in its domain store. `readStepResult` coerces assessments
persisted before finding severity existed from `findings: string[]` to
`{ severity: "major", text }[]`, so those runs remain readable and resumable.
There is no separate artifact, assignment, attempt, or budget table; nothing may
collapse into transcript parsing or one mutable run JSON blob.

The store enforces these invariants rather than trusting callers: a terminal
step or run refuses every further write (and ending a run cancels its open
steps), a result is written by the transaction that makes its step terminal and
never again, a paused run admits and starts nothing while letting a running turn
finish, every pause carries a reason, a step goes `pending → running → terminal`
with no shortcuts, a result carries the same status its step ends with, and each
mutation appends its own event with the actor that caused it. The only hard
removal primitive accepts a cancelled run and cascades through that run's steps
and events; active, paused, and completed runs cannot use it. The invariants a
later caller could otherwise quietly break are constraints in the schema: a
partial unique index makes "one active assignment per session" atomic across
runs, and composite foreign keys keep both a causal chain and an event's step
inside one run. Runs reach the browser as `WorkflowRunSummary` on the `workflow`
broadcast topic (`app/shared/workflow.ts`, projected by `workflowRuns.ts`); step
and event history is a per-run read. A live card is projected only when the
server knows the run's exact recipe id and version, so an old or foreign recipe
is never described with the current code-delivery decision function. A run
recorded against a version this build no longer carries therefore pauses as an
unknown recipe and cannot be resumed: the decision function that would move it
is gone, and guessing with the current one would derive a next step from rules
its history never followed. The operator move is to cancel that run and start a
fresh one on the current recipe — the worktree, branch, sessions and any pull
request are all preserved by cancellation itself. The cancelled card then
provides a separate permanent-delete action whose one confirmation can also
force-delete the owned local worktree/branch and archive its sessions; either
cleanup option may be turned off. Bumping the version is consequently a decision
about IN-FLIGHT runs, not only about new ones; the no-back-compat stance
(`CLAUDE.md`) is what makes it the cheap option rather than a migration.

### Concurrency and safety

Each run owns its worktree and runs at most one agent or host-operation step in
it at a time, so v1 needs no resource-claim scheduler. Host operations keep
their existing repository and PR mutation locks. Force-push is limited to
force-with-lease on the run branch during conflict recovery; a failed lease
pauses the run. Existing approval systems remain authoritative for integration
writes.

Starting a run is the user's authorization for exactly: the run's sessions, one
new worktree, local commits, and push plus PR creation after review passes. It
does not include merge, Task completion, remote-branch deletion, worktree
cleanup, or access outside the run worktree.

## The code-delivery recipe

1. **Start and plan.** The Task's **Run workflow** action captures a cheap
   coordinator runtime and four model/thinking candidate sets: `implementer`,
   `reviewer`, `fixer`, and `verdict`. Each entry also carries a free `family`
   string and optional short operator `notes`; both are selection evidence in
   the coordinator prompt, never hard routing rules. Implementer and reviewer
   sets require one to six entries. Fixer and verdict sets allow zero to six:
   empty fixer preserves the implementer fallback, while empty verdict skips
   final judgment. `WORKFLOW_ROLE_SET_BOUNDS` is enforced on both wire intake
   and resolved persistence because every candidate is rendered into a prompt.
   The start sheet also chooses the worktree's base branch: it walks the Task's
   parent chain nearest-first and defaults to the first ancestor with an active
   worktree in the same Project, otherwise to the main checkout's current
   branch. The user may still choose any active worktree branch in the Task's
   Project (for example, an epic branch). The base choice and prompt overrides
   remain per-run; runtimes and the last explicitly chosen ceilings are
   remembered browser-locally. By default, ceilings are sized from the
   coordinator's plan before implementation: low complexity gets 2 fix rounds /
   2 review passes, medium 4 / 4, and high 6 / 6. Choosing “Set ceilings myself”
   keeps both user values authoritative instead. The constrained coordinator
   submits complexity, the implementer, the FIRST discovery reviewer, and its
   rationale — the choices its evidence can actually carry. It picks no fixer
   and no verdict here: a fixer would be chosen against findings that do not
   exist yet, and both a two-line off-by-one and a rejected design arrive as
   `revise`, so those picks belong to the step where their evidence exists
   (items 4 and 5). It receives the Task-492 cross-family, calibration,
   cheap-fixer, and independent-verification evidence explicitly as guidance,
   not policy. It still does NOT plan how many discovery reviews the work needs
   before any code exists.
2. **Implement.** The implementation agent step runs in the worktree and submits
   an `implementation-result`.
3. **Commit and synchronization checkpoints.** Initial implementation uses
   `commit-sync`: the checked commit workflow with safety review, Project base
   refresh, and run-branch integration through `rebase-main`. When the run base
   is the main checkout's branch, refresh is the existing `pull-rebase` through
   that checkout; a different base is resolved from the local `origin/<base>`
   ref, refreshed with a targeted fetch, and never requires the main checkout to
   switch branches. Fix rounds instead use `commit`: the same checked commit
   path, but no base refresh, rebase, merge, push, or remote write. It retains
   the latest accepted synchronization checkpoint as its exact range base and
   refuses a missing or non-ancestor checkpoint. Once a finding author clears
   its lineage, `base-sync` refreshes the Project base and compares that exact
   head with the checkpoint. An unchanged base neither rewrites the branch nor
   repeats CI; a moved base reuses `rebase-main`, then exact-head publication/CI
   before the independent discovery pass. All three validate the active run
   worktree, branch, Project and repository identity, require a clean final
   state, derive the same bounded range statistics, and record previous/current
   base and head plus movement/rewrite flags. They never send slash-command text
   or expose mode selection as an agent tool: recipe history alone chooses the
   operation. Recovery is `retry-safe`; an already-created commit is observed as
   “no changes” and the exact checkpoint/range is recomputed. A user-requested
   semantic retry appends a successor but retains the failed/blocked operation's
   original idempotency key; validation recognizes that predecessor chain as the
   same reservation. Unsafe Git state pauses. A rebase conflict records the
   exact pre-repair head plus bounded file evidence before abort/restore;
   source-level truncation is carried to every prompt and card. It then gets one
   automatic repair assignment per conflict episode in the existing implementer
   session. What spends that one attempt is an agent that GOT ITS TURN: an
   assignment the runtime refused before the turn began is marked undelivered on
   its step, and the episode keeps its repair — nothing was seen and nothing was
   touched, so there is no state a second automatic attempt could surprise. A
   turn that started and then failed stays spent, whatever it did or did not do.
   Host-side completion checks require a clean, finished rebase onto the base;
   every blocked, failed, interrupted, restarted, or cancelled repair first
   stops its session turn, then is aborted and reset under the repository lock
   before verified restoration or terminal cancellation is recorded. Retry after
   a spent repair resumes the exact checkpoint operation that conflicted,
   preserving its routing payload, rather than invoking the agent again; a
   second conflict pauses with the manual resolve-then-Retry path. Nothing is
   forced.

   By default the initial commit/sync and every commit-only fix are followed by
   an exact run-branch push and bounded provider polling for that SHA. A
   checkpoint repeats publication/CI when synchronization moved the base or
   rewrote the head; an unchanged checkpoint reuses the current exact-head CI
   evidence. The first push also creates the run's one pull-request card as a
   **draft**: a GitHub draft, or a single-prefixed `WIP: ` Forgejo title. Card
   reservation and branch adoption make this retry-safe across crashes.
   Repositories without a configured provider are not pushed; no checks
   appearing is recorded as `none`, while checks still pending at the configured
   deadline are `timeout`. A per-run opt-out disables both early push and draft
   creation, and delivery then keeps the create-at-delivery fallback.

   A base move at a synchronization checkpoint may rewrite commits the run
   already pushed, so the next run-branch push (early or at publication) is a
   non-fast-forward. The operation recovers this one case itself: it reads the
   exact remote tip, requires it to be a head a prior completed commit/sync or
   CI observation of THIS run recorded, and overwrites only under a
   force-with-lease on that exact oid — a remote tip the run never recorded, an
   unreachable remote, or a lost lease race keeps the ordinary push failure. A
   CI observation retried past failed attempts still anchors to its exact
   commit/sync range: the same-reservation predecessor chain that validation
   accepts is the chain the recipe's next decision follows, and that chain is
   also followed across an automatic triage (below).

   **Automatic triage of a reproduced host-operation failure.** Any host
   operation that fails or blocks and then reproduces the IDENTICAL outcome on
   its semantic retry — `identicalTailAttempts >= 2`, the same kind, phase,
   status and summary — earns ONE bounded diagnostic assignment in the existing
   implementer session before the run pauses to the user. The failure is
   deterministic by then, so a third identical attempt is not what the run
   needs, and what a human would do with the pause is delegate it. The
   assignment carries the operation's exact failure text, fenced and named as
   untrusted host/provider output. A rebase conflict is excluded: it has its own
   repair with its own Git contract, and a conflict surviving that one is the
   manual path above.

   No failure CLASS is listed, because the trigger is not a taxonomy: what earns
   a triage is a retry that reproduced the byte-identical conclusion. A
   transient provider or network outage that heals reports something else on the
   retry and never reaches this, while a publication, draft-card or push failure
   that will keep failing does — which is the same distinction a per-class list
   would be trying to encode, drawn from the run's own evidence rather than from
   a guess about the class.

   The budget is spent the same way a rebase repair's is — by an agent that GOT
   ITS TURN, so an undelivered assignment leaves it unspent — and it is spent
   per failure episode, which the recipe walks across the retry chain of
   failed/blocked attempts at that operation.

   The Git contract is the OPPOSITE of the repair's: the triaged operation runs
   again immediately afterwards against the same range and reservation, so the
   triage must leave the checkout exactly as it found it. The host snapshots the
   branch, head and working-tree state under the repository lock before the turn
   begins — refusing the dispatch if it cannot — and checks it afterwards. A
   COMPLETED triage that moved any of them is refused with what it changed and
   nothing is undone: the agent still holds its turn. Every other outcome —
   blocked, failed, cancelled, interrupted by a restart — aborts the sequencer
   and puts branch and head back, hard-resetting and cleaning only where the
   snapshot was CLEAN, because that is the only state in which everything
   discarded was demonstrably created by the assignment; a triage handed
   uncommitted work gets a soft reset and keeps every byte. What the host could
   not verify is named in the step's safety evidence rather than papered over.

   Afterwards the recipe re-issues the SAME operation with the SAME routing
   payload, re-reserved against the triage step, and its second identical
   failure is the pause the user came to answer. The attempt counter treats the
   triage as an intervention rather than an attempt, so the count keeps running
   across it, and the run card says whose words the stopped tail carries — the
   agent's diagnosis, or the operation's own error.

4. **Assess and fix.** One primitive does every judgment: an agent reads a
   commit range and submits an `assessment` naming the exact head it judged.
   Three mandates use it, differing only in who is asked and what they are asked
   — a **discovery review**, fresh eyes over the whole range in a session of its
   own, one per review pass; a **re-check**, the agent that raised the findings
   asked in ITS session whether its own findings are resolved; and the optional
   **verdict**, a final judgment on the head about to ship (item 6).

   FINDINGS RETURN TO THEIR AUTHOR wherever that author still exists. Nobody
   else knows what a finding MEANT, and the author's session already holds the
   reasoning, so a re-check reconstructs no argument from a diff and costs no
   session. A session the user deleted is the one exception — it cannot be
   reopened, and the run takes a stand-in over a dead end (below) rather than
   stopping. A `revise` from a discovery reviewer is fixed and then re-checked
   by THAT reviewer; a re-check that comes back `revise` is fixed and re-checked
   by the same author again, bounded by the iteration limit; a verdict `revise`
   is fixed and re-checked by the verdict. A re-check consumes an iteration,
   never a review pass: passes count independent opinions, iterations count fix
   round trips.

   Which agent answers a finding is not knowable before the finding exists, so a
   `revise` never routes itself. The recipe asks the coordinator (item 5) and
   carries out the answer: the fix runs in the named fixer configuration from
   the fixer role set, or in the implementer's existing session when the
   coordinator routes it there — which is available at the FIRST revise, before
   any fixer has run, because "the approach is wrong" is exactly the finding the
   agent holding the design intent should answer. An empty fixer set skips the
   question, and an unusable answer falls back to that same implementer session
   rather than stretching the run's authority.

   A fixer session is keyed by its review lineage AND its configuration: one
   configuration answering one reviewer's findings reuses its session and
   remembers what it already tried, while a coordinator escalating to a stronger
   configuration opens a fresh one. Nothing carries a fixer's context across
   lineages. A fixer authors no design — it reads the worktree and the findings,
   and both travel — so its session is disposable by construction (invariant 1),
   where a run-long one only accumulates other reviewers' arguments and the
   context pressure that makes a small model sloppy.

   An assessment applies only to the exact `{baseCommit, headCommit}` range it
   was assigned: a `pass` naming another head never counts, and an assessment of
   an older base does not satisfy a checkpointed range even when the head SHA is
   unchanged. The recipe appends the required operation and a new assessment,
   consuming an iteration like a revision where the workspace moved. That covers
   every change the reviewer can observe at verification time; a change landing
   only after an exact-head pass is invisible to any assessment and is the
   delivery gate's to refuse (item 6). Fix commits remain intact — squashing is
   a merge-time choice.

   Every reviewer and post-review coordinator payload includes the exact SHA's
   CI outcome and per-check statuses. These are machine results; the
   implementer's verification report remains a claim. Red CI bypasses the
   reviewer entirely and sends the failing check names plus bounded provider
   output to the current lineage's fixer as CI-attributed findings, without a
   routing decision — a failed check names no author to return to and leaves
   nothing to choose between. Its re-check is the next CI result on the new
   head, not an agent. That spends a revision round but not a review pass.
   Consecutive red loops stop at the run's revision cap with the failed-check
   evidence; `none` and `timeout` continue to review and are stated explicitly
   rather than silently omitted.

   Every submitted assessment is also PUBLISHED, by the server, as exactly one
   durable review set on the run worktree (`docs/comments.md`): a thread per
   finding the reviewer anchored to a file and line, carrying its severity, and
   the set closed at once with the verdict (`pass` → approve, `revise` →
   request-changes, `fail` → reject) and the reviewer's own summary. Publishing
   from the result rather than asking the reviewer to author the set through the
   review tools is what makes it exact — one set per assessment, never left
   open, identical after a restart — and it costs the reviewer no extra turn.
   The set's identity is its STEP's rather than a fresh one, because a
   submission can be attempted again: the second attempt converges on the same
   set, adopting the threads already published and opening only the ones that
   were not, and a publication that fails partway closes its set on the way out.
   A RE-CHECK is the one assessment that publishes into another step's set — the
   one it wrote itself — and it SETTLES that set's threads, so the user reads
   one conversation per finding: raised, answered, re-checked. A finding it did
   not restate is one it accepted, and that thread is answered and RESOLVED; a
   finding it restated is answered and REOPENED whatever the fix round marked
   it, because nothing but a finding's author — or, where that session is gone,
   the stand-in judging in its place — may decide it is done. It recognizes its
   own findings through the thread ids its assignment carries rather than
   through anchors — the fix it just read is exactly what moved those lines, and
   the assignment therefore tells it to restate an unresolved finding with its
   severity and text VERBATIM, because a paraphrase both opens a second thread
   and closes the original as accepted. A session the user has deleted cannot be
   reopened, so when the author is gone the run does not strand: a replacement
   judges the findings in its place, and every text that would have claimed
   authorship says so instead — the assignment tells it to read each finding AS
   WRITTEN rather than assume what its author meant, and the thread settlement
   is signed by a stand-in rather than by the author — while a finding the fix
   round genuinely introduced opens its own thread. The set keeps the verdict
   its discovery pass closed it with: that verdict is what that pass concluded,
   and settlement lives in the thread state the card's rollup counts — once the
   set has been re-checked, the card counts what that re-check left, so nothing
   stays "answered and open" after the party entitled to judge an answer has
   judged it. Those counts are a SNAPSHOT the server reads back off the threads
   once settlement has run, carried on the re-check's own result: settlement is
   best-effort per thread, so a resolution that failed leaves its thread open
   and the card has to keep saying open rather than announce a transition that
   never landed. Nothing an agent submits can claim that identity — a submitted
   set or thread id, a claimed resolution, or a claimed settlement is stripped
   before publication rather than trusted. A finding the reviewer left
   unanchored still travels in the payload; it simply has no thread. Workflow
   sets are never blind: blindness only means something for parallel discovery
   in one worktree, which the recipe does not do, so `blind` stays reserved for
   a directly authored review round. Publication is best-effort: a worktree that
   has gone away costs the run no result.

   The fix assignment is then handed that set, rendered by the shared handoff
   helper with each thread's id and CURRENT anchor, and answers it where the
   user reads it — replying on every thread and resolving only what it actually
   fixed. A finding it rejects stays open with its reasoning on it. When the fix
   step finishes, the server reads those threads back into its result as
   per-finding resolution state — `resolved`, `disputed` (answered and
   deliberately left open), or `open` — which is what the author's re-check, the
   verdict pass and the run card consume. That state is a fact about the review
   surface, unlike the fixer's own dispositions, which remain a claim. It is
   also attributed: only the fix round's OWN replies answer a finding, so a
   comment the user or another agent left on a thread never becomes the fixer's
   recorded response and never makes an untouched finding read as disputed. A
   resolved thread is the exception and counts however it was resolved, because
   a resolved thread is resolved for every reader. What the round left is read
   back per set, so a CI round in between — which answers the build and owns no
   set — cannot stand in for the answer to a reviewer's findings.

   The work roles never message each other, but they do hold a conversation, and
   the recipe-owned payloads are its medium. A rework assignment carries the
   findings, the reviewer's own summary, and its non-blocking observations; the
   next review assignment carries what the implementer reported back — its
   summary, its notes, and its `responses` to findings it answered instead of
   fixing, which the reviewer must resolve explicitly by accepting or restating
   them. Neither side's prose ever becomes run state (invariant 1); the payload
   is what travels, and the transcript stays a record. FINDINGS are the one part
   that may never be shortened to make a payload fit. Every successor carries
   all of them, and a dropped one is recoverable by nothing the run has: a retry
   re-composes the same shortened assignment, and the coordinator deciding who
   fixes what has no review threads to fall back on — so a shortened list would
   either be worked silently or block a run that could never unblock. The bound
   therefore sits where the reviewer is still LIVE and can act on it: an
   assessment whose findings exceed `ASSESSMENT_FINDINGS_MAX_CHARS` or
   `ASSESSMENT_FINDINGS_MAX_COUNT` is refused at submission with the limit
   named, and the reviewer consolidates and resubmits within the same turn. Both
   bounds, because per-finding cost GROWS after submission — publication stamps
   a thread id on each one and a fix round adds a resolution per thread — so
   many one-line findings are the expensive case and only a count bounds them.
   What the reviewer WROTE is what is measured: the server's own thread ids are
   not counted against it, or an accepted assessment would fail its own contract
   the moment it was published and the run would pause on evidence it had just
   taken. Composition may still clip a finding's PROSE like any other text; what
   it may not do is drop the finding. Because each submitted result is bounded
   independently, the recipe also bounds every payload that COMPOSES those
   results: serialized assignments target 15,000 characters, leaving 1,000 below
   the store's 16,000-character ceiling. It clips the least-load-bearing prose
   first — non-blocking context before findings in a rework assignment, and the
   implementer report before the reviewer's evidence in a review decision —
   while preserving the source results unchanged. Every clipped string or
   omitted array tail carries the shared `…[truncated]` marker so an assignee
   never mistakes partial evidence for complete evidence. A coordinator's
   `focus` is the ONE group that is dropped whole instead, with no marker,
   because it is an instruction rather than evidence: half of "do not take
   approach X" can say the opposite of what the coordinator meant, and a marker
   cannot repair an inverted instruction the way it labels partial evidence. So
   the ladder under pressure reads: evidence clips, focus drops entire, findings
   never move.

5. **Decide.** No assessment routes itself. After EVERY one the recipe puts the
   same question to the coordinator in its EXISTING session, so deciding costs
   no session, in the one shape its evidence supports: after a discovery `pass`,
   `deliver` — naming the verdict runtime when the run has that set — or
   `review-again` naming another reviewer from the reviewer role set and an
   optional focus list, which narrows where that reviewer looks first without
   narrowing what it may report; after a cleared RE-CHECK, only which reviewer
   reads the moved head, because delivering a commit no discovery pass has seen
   is not a choice the recipe offers; after a `revise`, which fixer
   configuration answers these findings, or the implementer's session instead,
   with the same optional focus list — read there as how the round should
   approach findings whose scope is already settled, which is the coordinator's
   only channel to the agent doing the work, since the rationale is the run's
   record of WHO acts rather than a handover. Focus never excuses a finding:
   every one still has to be fixed or answered, and the fix round is told to
   refuse an item asking it to skip, downgrade or reject one — a rule the ROUND
   has to carry, since telling only the coordinator binds only the coordinator.
   Focus is also read past the authority check the runtimes go through: an
   out-of-set fixer or reviewer is refused as a runtime, but the same answer's
   focus still travels, because prose names no runtime and causes no step, and a
   diagnosis of these findings holds for whoever ends up answering them —
   including the implementer the run falls back to, which is the case that
   needed it most. The question is skipped wherever nothing is open — an empty
   fixer set on a revise, a single-candidate reviewer set on a cleared re-check,
   a pass at the ceiling with no verdict to name — and a skipped question steers
   nothing either: a revise with an empty fixer set goes straight to the
   implementer with no focus, because there is no coordinator turn to write one
   and buying a session per revise to obtain one is not worth it. It is asked
   wherever a pass IS open, including the one delivery buys for itself: a head
   that arrives at the gate with no passing discovery review needs one, and
   which reviewer reads it is the same question by another route, so a run with
   more than one reviewer is asked rather than having the plan's pick spent for
   it. A pass at the ceiling that nobody asked more of simply DELIVERS: the head
   carries a passing discovery review, so no step is blocked and nothing is owed
   the user. What does reach them is a want the run could not satisfy — a
   coordinator that asked for another pass and was refused by the ceiling
   (Limits).

   What it decides on is evidence, not the code: the range's bounded change stat
   and commit subjects, the assessment's own summary, findings and observations,
   the implementer's report and its responses, the accepted implementer's
   identity/family, the identity/family of every discovery reviewer AND every
   fixer used so far — each round with WHICH LINEAGE it answered, how many
   findings it was given, HOW MUCH IT WROTE as the commit/sync that followed it
   measured, and whether the assessment that judged it accepted the result — and
   both remaining ceilings. The size comes from that measurement rather than
   from the round's own notes, because a fix that outgrows the implementation it
   is fixing is the shape of re-implementation and no agent's account of its own
   work is evidence of it. For another pass it prefers a family unlike the
   implementer's and treats prior-reviewer diversity as evidence, not
   enforcement.

   A routing question also states, on each finding's own line, HOW MANY FIX
   ROUNDS have already answered that finding and had it raised again. The count
   is the run's record rather than an inference: a finding keeps its published
   thread across rounds, because a re-check that still wants it restates it
   verbatim and the server adopts the existing thread, so a thread appearing in
   N fix assignments was handed to N rounds and came back. That is the one fact
   separating "the last attempt did not land" from "a reviewer found something
   new", and the prompt asks the coordinator to route a finding a lineage has
   already spent rounds on to the implementer as re-implementation — a judgement
   the round list alone could not support, since it says how many rounds
   happened and never which finding they were spent on. The lineage travels on
   EVERY fix round for the same reason, an implementer-routed one included: it
   is the only record of which conversation a round belongs to, and it is inert
   for session identity, which keys the fixer role by the runtime named in the
   payload. A retried round counts once, like everywhere else. The count is not
   split by lineage and does not need to be: a thread belongs to the review set
   it was published in, and a new discovery or verdict pass publishes a new set,
   so a restated finding that reaches another lineage is a NEW thread whose
   count starts over — within one conversation the total IS that conversation's.

   The counts are a lookup table joined by thread, so they travel whole or not
   at all and give way EARLY under payload pressure: half a table does not
   shorten the evidence, it relabels a finding several rounds deep as one nobody
   has tried, and the findings' own text is what the room is for. Because an
   unmarked finding is itself a claim — no round has answered this one — a
   routing question carries the table even when it is EMPTY, and an assignment
   that has no table at all says so under the findings instead of letting them
   read as new. That distinction is the whole value of the evidence at the
   payload sizes where a run has taken the most rounds, which is exactly where
   it would otherwise be dropped in silence. An empty group is therefore never
   dropped: there is nothing to reclaim, and dropping it would turn the honest
   zero into the unreadable case.

   Reading a reviewer's report is not judging code. The reviewer read the code
   and wrote down what it found; routing on those words is the coordinator's
   whole job, and a reviewer that says a projection should not exist has already
   told it this is a redesign rather than a patch. Overruling is what it may not
   do: it cannot downgrade a finding, declare one wrong, or deliver a head no
   discovery review has passed. The recipe enforces the last of those; the
   prompt carries the rest, together with what to weigh when routing a fix — the
   severity mix, whether the findings read as a wrong approach or a missing
   case, how many rounds this lineage has taken and what its fixer produced,
   which findings those rounds already answered without settling, the
   configurations available with their operator notes, and the ceilings left.
   Nuance stays in the prompt rather than growing new contract fields — but a
   rule the prompt states has to be a judgement the evidence supports, or it
   asks for a call that cannot be made.

   Every bound stays with the recipe: a named configuration must belong to its
   role set and the review-pass ceiling must allow another pass. An unusable
   decision is not stretched into an authority — after a pass it delivers, since
   the range already holds a passing review and accepted work must not stall;
   after a revise it falls back to the implementer session; after a cleared
   re-check it takes the pass on the run's own reviewer. Naming no verdict is
   the one omission the recipe fills rather than refuses: a configured judge is
   something the USER asked for, so an unanswered choice uses that set's first
   member instead of shipping ungated.

   A fix assignment carries the runtime it was routed to, and that runtime is
   also its session identity: the same configuration answering the same
   reviewer's findings continues in the session that remembers what it already
   tried, while an escalation opens a fresh one rather than piling another round
   onto the context that stalled. Machine CI findings route themselves — a
   failed check names no author and offers nothing to choose between — and go to
   whichever fixer is already doing this run's work.

6. **Deliver.** Before verdict or delivery publication, the recipe appends a
   base synchronization preflight against the checkpoint associated with the
   passing discovery range. An unchanged base proceeds without rewriting or
   repeating CI; a moved base returns through rebase, exact-head publication/CI,
   and fresh discovery under the existing ceilings. Movement after that
   preflight remains the hosting provider's final protection/mergeability call.
   The delivery gate is deterministic, and it carries one precondition beyond
   head equality: the exact range it delivers must be named by a passing
   DISCOVERY assessment, and by a passing verdict when the verdict set is
   non-empty. A fix round changes the head, so the review that passed before it
   no longer describes what would ship — the run opens another discovery pass or
   asks the user (Limits), and a re-check or a verdict never substitutes for
   one. The verdict, when configured, runs last: after the discovery review that
   passed the delivered head and after the coordinator's `deliver` — or after
   the USER's `deliver` at a ceiling, which stops the run spending fix rounds
   and does not dismiss the judge they configured: the verdict still runs on a
   head a discovery pass accepted, and never twice on the same head. On a head
   no discovery pass ever read, delivering as it stands ships ungated, because a
   verdict judges the resolution of findings and there is nothing there to
   judge. Chosen then from the verdict role set, read-only, given the run's
   findings and responses and the exact range, judging resolution rather than
   rediscovering the change. What it is told about each finding is the NEWEST
   word on that thread, from whichever side spoke last: a fix round's own record
   until its author settles the set, and the author's settlement after — so a
   judge never reopens a dispute the reviewer who raised it has already
   accepted. Its `revise` starts another bounded fix round (item 4), which moves
   the head and therefore needs its own discovery pass before this gate can be
   reached again; its `fail` pauses for the user. A `fail` from ANY assessment
   pauses that way, and that pause has exactly two exits: the user cancels the
   run, or the user takes the work over by hand. There is no Retry — the
   assessment completed, and a completed step is immutable — and no gate
   offering to re-review or route the work anywhere. A `fail` is a reviewer
   saying the approach is wrong, which v1 deliberately treats as the user's call
   rather than something the run negotiates; unlike a ceiling, which is only a
   budget and therefore always raisable. That is the one dead end left on
   purpose, and a v2 that gives it a decision gate is where it would go. Then
   the gate itself: clean worktree, local HEAD equal to the head commit the
   passing assessment names, no unreviewed commits. Any workspace change after
   review forces a new commit range and a new assessment, bounded by the same
   iteration limit. A worktree left DIRTY at this gate is the user's to settle —
   commit or discard the stray work, then have the gate look again — and the run
   deliberately does not sweep it up: that work landed after commit-sync, so it
   is not the run's own, and committing it would move the head onto a commit no
   review names. There is therefore no shortcut past the gate for it; the only
   ways on are to clean the tree or to spend another round reviewing what the
   stray work changed. Publication repeats the gate immediately before side
   effects, then reuses `runPushWorkflow` and the existing `/pr` card
   creation/adoption seam. Both operations are retry-safe: push converges, and
   the PR seam reserves/reuses one live card and observes an already-landed
   branch PR before creating. When early push already created the draft card,
   delivery verifies that same PR and marks it ready instead of creating
   another: GitHub uses its ready-for-review GraphQL mutation, while Forgejo
   strips the one `WIP: ` prefix. Mergeability is then re-read AFTER that
   un-draft and written onto the card, because a draft's mergeability is not an
   answer at all (Forgejo reports every WIP pull request as not mergeable) and
   the observation wait consumes the card immediately afterwards. Publication
   always writes that final provider detail's exact head into the card and
   rotates its observation generation, including for an already-reviewable PR: a
   poll already in flight may have read the previous head, and the new wait must
   never consume that stale snapshot. Final provider detail must report the run
   head/base branches and a remote PR head exactly equal to the reviewed commit;
   otherwise the run pauses. The Workflow card links that PR and opens its
   owning session rather than copying the live card's CI/review state.
7. **Observe.** A wait step durably names the live PR card and exact reviewed
   head. The card's background watcher feeds CI, hosted review, conflicts,
   mergeability, remote-head changes, closure, and merge observations into it;
   boot reconciliation re-evaluates the persisted card even without a browser.
   CI failure or hosted changes-requested pauses the run and alerts the user; a
   CONFIRMED base conflict on a non-draft PR pauses with a user-authorized
   rebase-and-re-review path — a bare `mergeable: false` is never that evidence,
   since completing the wait cannot be undone by the correct later poll. A
   completed moved-head observation is the recoverable exception: Retry appends
   a fresh immutable wait so a card that has since caught up can proceed, while
   a genuinely moved head pauses again rather than inheriting the old review.
   That deterministic rebase uses the same one-attempt conflict repair rule as
   commit and sync: the existing implementer session resolves minimally, runs
   checks, and leaves the rewritten branch for a fresh review; a repeated or
   declined conflict pauses with file evidence and the manual path. Green CI,
   known-clean hosted review, and mergeability for the reviewed head pause at
   the persisted merge-decision seam. These attention states send Web Push to
   the Task and make its Backlog row carry the existing attention marker.
8. **Merge and complete.** Merge is a persisted user-decision step whose
   assignment records the allowed `merge`/`cancel` choices. Every later card
   snapshot re-evaluates an open decision: readiness keeps waiting, merge
   settles it, and a moved head, closure, or base conflict supersedes it with
   observation evidence and routes through a fresh observe step. Provider
   snapshots carry per-card generations reserved before provider reads, merge
   calls, and head-changing pushes, so an older watcher response cannot
   overwrite a newer reactive conflict read. A Workflow merge first verifies the
   fresh provider head and supplies that reviewed SHA to the provider's atomic
   merge call; a conflicting mergeability in that preflight is asked again
   before it may supersede the decision, and an unanswered one is left to the
   provider. A merge refusal is re-fetched once; provider state classifies a
   moved-base conflict, while classification failures preserve the provider's
   actionable refusal. If supersession races a successful exact-head merge, a
   final merged observation completes the append-only run. A successful use of
   either existing merge surface records the selected merge method and remote
   branch choice; a merge performed in the hosting UI is recorded as an external
   choice. A PR into a non-default base branch does not open the separate
   provider-default-branch approval; the Workflow merge decision remains the
   user gate. In both cases the run completes only from the observed `merged` PR
   state, including after restart. The existing Task-done suggestion remains a
   separate, user-visible follow-up on the live PR card — never automatic.
   Completed runs and retained cancelled runs keep their sessions, review
   evidence, and PR link on the Task.

   Both the merge decision and the safe worktree cleanup are also DIRECT
   controls on the run's Workflow card, so a delivery is finished where its
   evidence is rather than by going to the PR card's session and then back to
   the Sessions inbox. They run the live card's own merge and cleanup — one
   implementation, one set of provider refusals — reached from the run: the
   server answers whether each is offered (`WorkflowRunDelivery`, joined onto
   the card from the pull-request card the run published), and a control the
   projection does not offer is one the message behind it refuses. Merge follows
   the RUN (its merge-decision step is open) and keeps the method and
   remote-branch choice per click; cleanup follows the CARD (merged, a worktree
   still named, not already retired) and is never offered for a cancelled run,
   which has its own delete action. A card patch re-broadcasts the run list only
   when it would change one of those answers, so the watcher's every-poll patch
   costs nothing.

   What is RUNNING is the server's answer as well, but not instantly: the run's
   `busyAction` is the pull-request card's, reached through a store write, an
   asynchronous broadcast and a whole run-list rebuild. The click carries its
   own request id and busies the control it pressed immediately, so the browser
   that pressed it never shows a button that answers nothing; every other viewer
   still learns the action from the run list, which remains the one durable
   statement of it. It is a spinner and nothing more — no row is moved and no
   list is patched optimistically — so there is nothing to roll back when the
   answer is no.

   That local claim survives run-list broadcasts about anything else, and the
   RUN LIST is what retires it: the list stating an action on the card, or the
   first list after the click's `mutationSettled`. Letting go on the settle
   alone would offer Merge again over a pull request that may already be merged
   — the list stating what the action came to is a best-effort broadcast that
   can follow the settle, or fail to be sent at all. So the settle ASKS for that
   list, with the per-topic resubscribe a state-event gap uses: a subscribe is
   answered from the stores as they stand, which is the same authority without
   depending on a broadcast arriving. Any list retires the click, its cause
   included, for the same reason. A refusal raised before the card was touched
   retires it too, carrying the same request id — which is why that refusal is
   always sent, even when the card is still holding an older failure of its own.
   Two more things end a click without an answer: the socket it was sent on (its
   settle can only arrive there, so a reconnect hands the control back to the
   authoritative snapshot) and a long deadline, which applies only while the
   click still owns the control. The failure the click has already answered is
   HIDDEN while it owns the control — the card clears its stored refusal only
   when it dequeues the next action — and never edited away, so the failure
   standing on the card when the click lets go is the one shown.

   Cleanup from the Workflow card adds exactly one consequence to the card's
   own: after the checkout is retired and the sessions on it are settled, the
   RUN is settled too, which is what takes the finished delivery out of the
   Sessions inbox. That settlement is best-effort — the checkout is gone either
   way, so a refused acknowledgement never fails an action that succeeded. It is
   not remembered as a sentence either: the card states a retired checkout whose
   run is still unacknowledged as a live CONDITION derived from the run's own
   attention cursor, on the same predicate the inbox decides membership with, so
   it retires itself the moment the run is settled from anywhere and can never
   go on asking for a Settle that already happened. The REASON a Settle is
   refused is never copied onto the Task; the inbox item carries it live, in the
   one shared wording, on the Settle it disables. A cleanup invoked by one of
   the run's OWN role sessions, which is how `workflow_gate_action` reaches it,
   does not attempt the settlement at all: that session is streaming the very
   turn making the call, so the acknowledgement would be refused on it every
   time — and rightly, since the turn still owes an outcome that would resurface
   as a card of its own. The run keeps its Settle there, and the outcome says
   so.

   What the two controls OFFER is the delegated action's own eligibility, not a
   looser restatement of it: merge requires the card to still be `open` (a merge
   landing at the provider marks the card merged while the run stays paused
   until its observation completes it), and cleanup resolves the worktree the
   way the card action does — the card's own id first, its session's as the
   fallback — never from the run row, which may name a different one. Neither
   control reports a failure the card already carries: the card persists it and
   the Workflow card renders it beside the button, so only a refusal raised
   before the card was touched is announced on the Task.

   Every one of the run's sessions belongs to the run's checkout and settles
   when that checkout is cleaned up, exactly like any other worktree session.
   Settling is soft, so a session the user picks back up returns to the working
   set. Cancelling settles nothing: it preserves the run's sessions like
   everything else it leaves for the user to decide about. A cancelled run's
   explicit delete action is the quick mistake-recovery path: deleting the run
   history is mandatory after confirmation, while force-deleting its owned local
   checkout/branch and archiving all run/worktree sessions are independent
   options (both offered on by default). A worktree cleanup refusal leaves the
   run and sessions intact so the action can be retried.

The user still authorizes every gate and state change: blocked states, failures,
and every pause remain theirs to act on, and every pause states its reason. A
restart is one of them: a provider turn lives in the process that started it, so
an agent step interrupted by one is failed and paused with its evidence rather
than adopted — invariant 6's indeterminate pause, chosen over re-dispatching an
assignment whose dead turn may already have changed the worktree. The existing
Retry appends the same assignment once the user has looked. Delegated work the
dead turn still owed does not hold that failure back: the obligation the session
owes its children is recorded on the step rather than enforced against it,
because nothing can ever clear an obligation on behalf of a turn that no longer
exists, and a step held running behind one is a run neither Resume nor Retry can
reach. Abandoning a turn may only ever end a step in FAILURE — the invariant
that a session cannot report SUCCESS while it owns delegated work is untouched.
That obligation also stops blocking the RUN's completion, for the same reason it
stopped blocking the step's: nothing the run can do will clear it, so enforcing
it at the end would refuse the terminal transition after the merge was already
observed and leave a finished run unable to say so. Every other session is still
held to it, and the refusal now names the way out — settle the delegated work on
that session, then Resume.

### Limits, and who raises them

A run has TWO ceilings: discovery passes (`P`, how many independent opinions it
may buy) and fix iterations (`I`, how many fix round trips it may spend). `P`
must be at least 1, because delivery requires a passing discovery review; `I`
may be 0. Nothing constrains them against each other. `P > I` is a legal
configuration and a meaningful one — "three opinions, and no agent touches the
code again without me" — it simply reaches the user sooner, which the start
sheet hints and no validation forbids. An automatic start waits at those legal
floors for the opening plan, then atomically applies the complexity defaults
(low 2 / 2, medium 4 / 4, high 6 / 6) before implementation. An explicit pair
from the user bypasses that sizing and remains authoritative.

Sessions are DERIVED, never configured: coordinator, implementer, one per
discovery pass, one per (lineage, configuration) fixer, and the verdict — at
most `P + I + 3`, and typically five to seven. An independently configured
session ceiling could contradict the other two, permitting three passes while
denying the sessions to run them, and it forced a session floor at start to
reserve room for optional roles. Both mechanisms are deleted rather than moved.

A ceiling only reaches the user when it BLOCKS something. A head that no
discovery pass has read is owed one, so the run buys that pass while the ceiling
allows and asks only when it cannot — a gate that asked for a pass the run could
take itself would return to the same gate however high the ceiling went.

A ceiling is a bound on automatic work, not a verdict on the work. Every one of
them reaches the user the same way — a blocked fix round, a blocked discovery
pass, a re-review the delivery gate demanded after the workspace moved, a CI-red
loop that ran out of rounds, and a pass the coordinator asked for and could not
have. When the recipe needs a step a ceiling forbids, the run neither delivers
nor stalls: it opens a user-decision step — the same primitive as the merge gate
— carrying which ceiling blocked, what the coordinator wanted to do next and
why, what it has spent on what BEFORE the demand it could not meet, and the
choices it can actually carry out: raise the ceiling — the card uses a discrete
slider to offer one through ten more of whatever blocked, while the wire also
accepts a relative N for either/both ceilings or an absolute target. A raise
answered at the gate has NO maximum: the start-sheet bounds guard a one-tap form
against a typo, while the gate is the user explicitly allowing more work on a
run that already hit its bound, so the wire floors absolute targets at each
minimum and caps neither — cancel, and either deliver as it stands, whenever a
commit holds what would ship, or RE-EVALUATE where the workspace is what
refused: commit or discard the stray work yourself and the run observes the
checkout again, which is the one answer a pure recipe cannot give itself. A
ceiling already at its bound therefore never leaves cancel as the only exit:
even a gate with no commit to ship AND no delivery gate behind it to re-read
offers raise beside cancel, and cancelling still preserves the worktree, branch,
sessions and any pull request. Delivering a head that no discovery review has
passed is possible ONLY through that choice, made by the user and recorded as
one. Raising at a user gate updates the run's ceiling columns and appends its
own event with actor `user`; automatic plan sizing uses the same atomic event
with the coordinator actor and a `plan-complexity` adjustment, so history
explains either move. The columns hold the CURRENT ceiling rather than the
starting one, and a raise never lowers one — a ceiling under what the run
already spent would describe a past that did not happen, and stopping sooner is
what cancel is for.

Answering resumes rather than restarts: the raise moves the bound and the recipe
derives the move it was blocked on again from the history before the gate, so
nothing has to remember what the run was about to do. A raise that would move
nothing is refused rather than recorded — settling the gate on it would close
the only surface that can move a ceiling — and a raise that moves one ceiling
while another still blocks the run opens the gate again with the current numbers
instead of stopping. Cancel is one of the gate's own choices, so the step
records it like any other answer.

### The coordinator role

The coordinator is the run's advisory concierge/operator: one cheap, durable
session in the run's worktree, with no codebase access and no reach into sibling
session transcripts or prompts. Its worktree edge files it with the run and
keeps its cwd consistent across resumes; it does not grant file, shell, or git
authority. It talks ABOUT the run at the resolution of persisted step results;
richer work evidence must come through richer structured results, not
`session_read` or `session_send_prompt`. Its read-only `workflow_status` tool
infers the run from that session and projects persisted lifecycle and pause
evidence, bounded step history, limit consumption, role sessions, PR observation
state, and the recipe-derived next wait. This makes user conversation between
assignments legitimate. Deferred `workflow_gate_action` is not new authority: it
is a strict, run-inferred alias for whichever resume, semantic retry,
merge/cancel decision, Task-done answer, or safe-cleanup control the card
already offers in the run's actual state — merge and cleanup through the very
same seam the card's buttons use, so the agent alias cannot drift from them. A
refusal names that state rather than stretching recipe bounds.

The recipe asks it two bounded questions in that ONE session:

- the opening `work-plan`: complexity, the implementer, the first discovery
  reviewer, and a rationale;
- a `review-decision` after EVERY assessment: after a pass, `deliver` or
  `review-again` optionally naming another reviewer and a focus list; after a
  revise, the fixer configuration that answers those findings or the
  implementer's session, again with an optional focus list — the one thing it
  can say TO that round; before delivery, the verdict configuration when that
  set is non-empty. Always with a rationale.

Both are DATA, not authority. The recipe reads the result and decides what it
may cause: configurations come only from their role sets, the two ceiling
columns cap the loop and only the user raises them, and the delivery gate still
requires a current passing discovery assessment. Between assignments the
coordinator may explain recorded state and propose a user action, but invokes an
action only when the current user message unambiguously requests it. Merge,
cleanup, and cancel are restated before the call, and cancel requires the
message to name cancellation. Every Workflow event keeps actor kind `user` with
`via coordinator session …` as its actor id; it is never recorded as an agent
decision. The same controls remain independently available on the card. A
creation-only coordinator projection of `task_manage` may file explicitly
requested process follow-ups; it cannot edit existing Tasks, links each one
under the run Task, and records the PR as its source while the Task domain
records the creating coordinator session. Further cross-domain tools must earn
their way individually.

It must distinguish a recorded wait from state that fails to explain a stall,
never fill that engine fault with an invented account. Nothing that moves on its
own enters its choices: the start sheet shows the accounts' subscription usage
for the person picking, and it is never passed to the coordinator — the same
Task must not plan differently because a meter moved.

Moving a choice out of the plan is the point of the split, and the same argument
governs all of them: a decision made before its evidence exists is a commitment
the run must then honor against what it later learns. The pass count went first
— "review twice" survived a first pass that had settled the matter. The fixer
and the verdict follow it for the same reason, since a fixer picked at plan time
is picked against findings nobody has written yet. Deciding at the step where
the evidence lands costs nothing extra: every one of these questions reuses the
coordinator's existing session, and each is skipped when it has no open answer.
The role needs no new table, step kind, or tool — one registered contract, wider
in what it may answer, and recipe branching.

## UX contract

- The start surface is a compact configuration SUMMARY, not a wizard: one line
  per runtime (model, account, thinking), one row expanded at a time for
  editing, the two run ceilings as bounded sliders whose numbers stay visible,
  and a reset to the recommended defaults. There is no session control: the
  count follows from the ceilings and appears only as usage on the card.
  Configurations are added and removed there within the shared bounds — adding
  stops at the maximum and the last one cannot be removed — and the copy follows
  the count rather than assuming a pair. Nothing there may state a fixed
  implementer/reviewer assignment, because the coordinator makes it. Every run
  limit is a CEILING, and the surface has to say so — its heading, the number
  beside the slider, and the slider's spoken value all read "up to N", and each
  hint names who decides the actual number. A bare "Review passes: 2" reads as
  an order to run two reviews, which is the one thing these numbers never mean:
  the review-pass hint says that the coordinator decides after each review
  whether another is warranted.
- The Task offers **Run workflow**; each run shows one card with its phase,
  running/waiting/blocked state, session links, reviewed-commit status, PR/CI
  status, the next automatic action or required decision, and pause, resume,
  cancel, and retry controls. Every linked run session, including the
  internal-only coordinator persona, remains viewable after navigation, reload,
  and resume even though that persona is absent from ordinary creation pickers.
  Each review pass is its own session, and the card links the newest session of
  every pass — not only the last one — and the fixer session of every lineage
  beside the reviewer whose findings it answered, since which agent fixed what
  is now a decision and not a constant. Passes are numbered within a round, so a
  later round's card links that round's reviewers; earlier rounds stay in the
  session list and in the run's step history.
- A blocked ceiling reaches the user as a decision, not as a dead end. The run
  pauses at it exactly as it pauses at the merge gate — the reason names the
  ceiling and what the run wanted to do — and the card carries which ceiling
  stopped it, what it has spent against both, and the choices that gate can
  carry out. The card raises the blocked ceiling by a slider-selected N, while
  the wire accepts relative amounts for either/both ceilings or an absolute pair
  at or above each limit's minimum — neither is capped by the start sheet's
  maxima. `run-ceilings-raised` records `from`, `to`, the computed `by`, and the
  requested adjustment. "Deliver as it stands" states plainly when it would ship
  a head no discovery review has passed, because that is the one thing the
  recipe will not do on its own, and it is offered only when a commit holds what
  would ship; where the workspace is what refused, the card offers "Look again"
  instead. Resume is not offered while that decision is open: resuming would
  only reach the same ceiling.
- The card shows the latest assessment's own words — the reviewer's summary, its
  findings, and its observations — because that is the only surface where review
  evidence reaches the user outside the reviewer's transcript. It shows the
  coordinator's newest CARRIED-OUT decision the same way: what the run did with
  it, after which pass, the coordinator's own rationale, and the focus the next
  pass or the fix round was actually given. What it DID is read from the step
  that followed the decision, never from the answer — the contract accepts every
  discriminant for every question, so an out-of-set fixer, a `deliver` answered
  to a routing question, or a pass the ceilings refused would otherwise be shown
  as the opposite of what the run is doing, and a runtime the recipe defaulted
  would not be shown at all. A decision nothing has followed yet is not
  described. The card is a list broadcast, so the projection bounds those lists
  and says when it shortened them rather than hiding the remainder.
- Backlog rows carry only a compact run/attention indicator. The Sessions inbox
  goes one step further and shows every live run as one item of its own
  ([Task-676](pa://task/676)): paused runs under **Needs you** with the reason
  they stopped for, active runs in the working list with their phase and next
  action, and the run's role sessions folded into a bounded line rather than
  spread across a card each. Membership comes from the structured session ids on
  the run's card projection and from nothing else, so an absent or unsupported
  projection folds nothing and no session can go missing behind a run that
  cannot describe itself. A role session that needs a human still lifts and
  names itself on the run item, a search still reaches every folded session, and
  the item opens `/tasks/:taskId#workflow-run-:runId` — the run's own card,
  where its evidence and every control are. The inbox item steers nothing.
- A run's ENDING is the user's to acknowledge ([Task-677](pa://task/677)). Each
  run persists an attention cursor of the same shape as a session's
  (`attention_revision` / `attention_settled_revision`, migration 0058): the
  store raises the revision inside the lifecycle transition to `paused`,
  `completed` or `cancelled` — a resume, a step, agent progress and viewing
  raise nothing, and re-deriving the identical pause is not a new event. A run
  that ended stays one **Needs you** item with its outcome and reason until it
  is settled, and the `workflowRunList` broadcast keeps carrying its card
  projection so its roles stay structurally folded under it. Existing runs start
  with no cursor, so historical terminal runs are not resurrected; a run paused
  at the migration starts awake, since it is already an inbox item.
  `settleWorkflowRun` carries a REQUIRED `throughRevision` — the acknowledged
  revision only ever moves forward and is clamped to what was observed, so a
  stale click leaves a newer event awake — and it is refused BEFORE anything is
  written, with the shared `workflowRunSettleBlockedReason` wording while the
  run's current gate is an unresolved user decision or a cancellation is in
  flight, and with the role's own `settleBlockedReason` while any session the
  card names cannot be put down. An accepted Settle writes those role sessions —
  through their current outcome revisions, with no further check — and the run
  cursor back to back without yielding, then awaits the session list's flush and
  only then broadcasts the run list, so no client sees the settled run while its
  roles are still unsettled. The cursor is a reading position, not a transition:
  it is the one column set a terminal run still moves, and it appends no event.
  `app/web/docs/ui-shell.md` owns the inbox contract.
- Cancel is immediate and durable, even when a host operation holds the run's
  chain for its own deadline: the request is recorded and broadcast before the
  settlement queues, the card says CANCELLING and offers no control that
  contradicts it, Resume is refused while it stands, and boot settles a request
  whose process died before it could. A run the user ended never comes back as
  an ordinary paused run.
- Pause prevents new step admission without aborting a running turn. Resume
  changes only a paused run; a duplicate Resume on an already-active run is a
  no-op and appends no event. Cancel prevents new work and preserves sessions,
  the worktree, and the PR unless the user separately cleans them up.
- A run that cannot proceed PAUSES; it never stalls quietly. When the store
  refuses the very step the recipe decided — a payload over the metadata cap, a
  write append-only history forbids — that refusal becomes the pause reason, the
  pause event, and a log line, because an "active" run that will never move
  again is the one outcome nobody can act on. The card then states that reason
  instead of announcing the step the run did not take, and resume — or retry,
  where the stopped tail allows it — re-derives the decision once the cause is
  fixed.
- A retry that REPRODUCES its predecessor's outcome has to say so. A semantic
  retry re-runs the same assignment, so a deterministic step re-derives the
  identical result within a second: the pause reason then differs from the
  previous one by a step number alone, which is indistinguishable from a button
  that did nothing. Identical consecutive attempts — same step kind, phase,
  status and summary — are counted; the durable pause reason names the count,
  and the card carries it as its own field, which is the whole chain read as one
  number instead of N identical rows. The count is stated ONCE where the run's
  reason is shown, never twice, and it does NOT cap the retry: only the user can
  know whether the condition the step reported has been repaired outside the
  run, so the card says what another attempt would do — re-run the same
  assignment, which a repair or an agent step's fresh session can still end
  differently — asks for confirmation, and then runs whatever the user chose.
  Refusing the attempt after a repair would leave cancel as the only exit.
- Manual controls never depend on an agent being available.

## Implementation phases

1. **Runtime through the review loop** — the three tables, recipe engine, agent
   and host-operation steps, `session_submit_result` with the two contracts,
   boot reconciliation, the workflow card, and pause/resume/cancel.
2. **Delivery and observation** — push and PR operations, the exact-head
   delivery gate, durable CI/PR observation, the merge decision, completion, and
   post-merge follow-ups.

The coordinator role lands only after both phases work end-to-end, so its
experiments have a fixed baseline to measure against.

3. **Closing the loop** (v1.4, in that order, each shippable on its own) — first
   correctness: the author re-check after every fix round, the coordinator
   decision after every assessment, and the delivery gate's passing-discovery
   precondition, which together make run 72's path impossible. Then routing:
   coordinator-chosen fixer configurations, implementer routing, verdict chosen
   before delivery, and fixer sessions keyed by lineage and configuration. Then
   the ceilings: the session control and session floor removed, the ceiling
   columns made raisable, and the blocked-ceiling decision card.

## Deferred, and why v1 does not block it

Each of these was designed in the earlier proposal and deliberately cut. The
generic step rows, typed result contracts, and append-only event model are the
extension points they would build on:

- **Coordinator expansion.** Run status, the existing card's user-instructed
  decision aliases, and creation-only follow-up Task filing are implemented.
  Pause, autonomous advancement, discretionary delegation, further cross-domain
  tools, and a spawn tool (`session_spawn`) remain out of scope. Direct
  conversation with work-role sessions remains intentionally rejected rather
  than deferred: the coordinator gets structured step results, never
  `session_read` or `session_send_prompt` access.
- **Declarative definitions.** A serializable graph language with definition
  snapshots replaces the recipe decision function without touching persisted
  steps.
- **Budget ledger.** Monetary/token reservation and reconciliation replaces the
  plain limit columns when adaptive delegation exists to spend a budget.
- **Artifact store.** A typed, versioned artifact table with lineage generalizes
  the commit-range-in-result pattern when a second recipe needs shared versioned
  outputs.
- **Resource-claim scheduler.** Reader/writer claims arrive with parallel steps
  in one worktree; v1 serializes by construction.
- **Unbounded or silent conflict repair, competing-run choreography, inline
  result schemas, subworkflows, additional recipes.** Conflict repair is limited
  to one visible assignment in the existing implementer session per conflict
  episode; a second conflict pauses with evidence rather than guessing again.
  The remaining items are additive through new step rows, contracts, or recipe
  code.

The generality test stays binding: if a future recipe requires core model fields
named `reviewer`, `commit`, or `pullRequest`, the core is too specific.
