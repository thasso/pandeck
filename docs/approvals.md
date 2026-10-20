# Approvals and session grants

Every agent-proposed mutation that needs the user's consent goes through one
approval card (`app/server/src/pendingApprovals.ts`, `ApprovalCard` in
`app/shared/protocol.ts`). The agent's tool creates the card and ends its turn,
the user answers, the server executes, and the outcome reaches the agent as a
hidden prompt through `agentHandoffs.ts`.

## The cards

| Card kind                 | Raised by                                                                                     | Grant keys                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `githubPullRequest`       | `github_{create,edit,review,comment,assign}_pull_request`                                     | `github:create` … `github:assign`                                      |
| `githubIssue`             | `github_mutate_issue`                                                                         | `githubIssue:create` … `githubIssue:label`                             |
| `githubBranchDelete`      | `github_delete_branch`                                                                        | `githubBranchDelete`                                                   |
| `forgejoPullRequest`      | `forgejo_{create,edit,review,comment}_pull_request`                                           | `forgejo:create` … `forgejo:comment`                                   |
| `forgejoRelease`          | `forgejo_create_release`                                                                      | `forgejoRelease`                                                       |
| `jiraIssue`               | `jira_mutate_issue`                                                                           | `jira:edit`, `jira:create`, `jira:comment`, `jira:rank`, `jira:sprint` |
| `confluencePage`          | `confluence_mutate_page`                                                                      | `confluence:create`, `…:edit`, `…:comment`, `…:delete`                 |
| `tempoWorklog`            | `tempo_mutate_worklogs`                                                                       | `tempo:create`, `tempo:update`                                         |
| `gmailArchive`            | `google_gmail_archive`                                                                        | `gmailArchive`                                                         |
| `sessionSpawn`            | `session_spawn` with `operation: "propose"`                                                   | `sessionSpawn`                                                         |
| `managedPullRequestMerge` | `worktree_finish_pull_request` into the default branch                                        | `managedPullRequestMerge`                                              |
| `managedCommitOverride`   | `worktree_commit` with `force: true`                                                          | none: never granted                                                    |
| `projectCreate`           | `project_create`                                                                              | `projectCreate`                                                        |
| `agentDefinition`         | `agent_create`, `agent_edit` changing `persona`, `model` (the list), `effort` or `peer-turns` | `agentDefinition`                                                      |
| `settingsInput`           | `settings_request_input`, `accounts_sign_in`                                                  | none: never granted                                                    |

`github_resolve_review_thread` also raises a `githubPullRequest` card, with
operation `resolveThread`. Resolving and reopening both use `github:comment`,
including existing and inherited grants. The grant's displayed coverage includes
these thread actions; no new grant key is required. See
[pull-requests.md](pull-requests.md#resolving-provider-review-threads).

The `commit` kind remains readable for stored cards; nothing creates it today.

A `settingsInput` card asks the user for a secret or an account connection the
Personal Assistant may not handle itself (`docs/settings.md`). It has no grant
key, so no earlier decision answers it and it is never auto-approved. A secret
card can be approved only with the value in the decision's edits: `prepare`
holds it in memory for that one resolution, `execute` writes it, and the
executor's `release` hook (called in a `finally` around the whole resolution)
drops it however the resolution ends. The stored card never carries it. A
sign-in card (`signIn` mode, raised by `accounts_sign_in`) refuses approval
until its Claude or OpenAI account is enabled and signed in, and is approved
when the account change is announced. A connection card refuses approval until
the account is connected and is approved by the server when the OAuth callback
announces the grant.

A `managedCommitOverride` card asks the user to commit past a commit review that
blocked a managed worktree commit. It shows that approving overrides the review,
every blocker, the agent's reason, the branch, the scope (all or staged
changes), and the proposed message and files. It has no grant key for the same
reason as `settingsInput`: each override answers its own findings, so the card
offers only Approve and Reject and is never auto-approved. The tool and executor
contract is in [pull-requests.md](pull-requests.md#commit-review-override).

`github_rerun_actions_run` writes without a card: a re-run loses nothing and is
what an agent watching CI needs inside its loop. A branch-delete card binds the
commit each branch pointed at when proposed; its executor re-checks the default
branch and protection, then deletes through GraphQL `updateRefs` with that
commit as `beforeOid`. REST `DELETE /git/refs` takes no expected value, so a
push landing between a read and that call would delete the new tip; the atomic
check refuses it instead.

GitHub answers 2xx while silently ignoring issue changes the token may not make
(assignees, labels, state without push access), so the `githubIssue` executor
checks each response: an ignored edit step fails the card and names the steps
that landed, and a create that lost labels or assignees stays executed with a
warning, because the issue exists.

## Proposed text

A card that proposes prose (a pull-request or issue description, a comment, a
review summary, release notes, a Jira ticket, a Confluence body) renders it as
Markdown the way the target will show it, clipped to a preview, with a "Read
full …" dialog that carries the card's own Approve and Reject
(`ProposalText.tsx`). A review's dialog holds the summary and every inline
comment, since approving submits all of them; the card lists only the first
eight.

An edit that replaces a whole text also records the text it replaces when the
agent proposes it: `previousPrBody` on the GitHub and Forgejo description edits,
`previousTitle` and `previousIssueBody` on a `githubIssue` edit. The card then
offers "Show changes", a diff of the Markdown source with the whole document as
context. The record is a snapshot: a description changed on the provider after
the proposal is still overwritten by the approved write. The pull-request read
goes through `gitHosting.ts`, and every such read is bounded like any provider
request (`proposalSnapshot` in `pendingApprovals.ts`). A failed or timed-out
read proposes the card without the record rather than refusing it. A cancelled
tool call creates no card.

## Superseded cards

A proposing tool can pass `supersedes` to `createApproval`. In the same store
write that adds the new card, every still-pending card of the same session that
matches becomes `superseded` (with `supersededBy`): it leaves the pending strip,
stops marking the session as waiting, and can no longer be decided. A card with
a decision in flight is never superseded. The agent gets no outcome for the old
card; the new card's outcome answers both.

`managedPullRequestMerge` supersedes an earlier card for the same provider,
repository and pull request number, so re-staging a merge after new commits
leaves one card to approve. `managedCommitOverride` supersedes the session's
earlier override for the same worktree.

## Finding a card

A card sits right after the tool call that proposed it, so an agent that keeps
working afterwards pushes it up the transcript. Two things point back at it,
both described in `messaging.md` ("The agent is blocked on the user"):

- The composer's `PendingApprovalsLedge` names every card the viewed session is
  waiting on and jumps to it. A covered card (`autoApproved`) waits on nobody,
  so the strip leaves it out.
- Each proposing tool's result ends with `approvalCardReference(card)`, a
  `pa://approval/<id>` link the agent puts in its reply. It renders with the
  card's live status and opens the card through the same jump.

## Session grants

"Approve for session" on a pending card approves it AND records every operation
it performs as a grant for that session. A grant is an operation, never a
target: `jira:comment` covers a comment on any issue. Keys and labels come from
`approvalGrantKeys`/`approvalGrantLabel` in `app/shared/approvalGrants.ts`.
Every card kind with a grant key offers the button; `settingsInput` and
`managedCommitOverride` have none, so their cards never do, and the server
ignores a for-session decision on such a card.

- **Scope.** Every grant has one (`ApprovalGrant.inheritable`). "This session
  only" (false) covers the holder's own cards. "This session and the sessions it
  starts" (true) also covers every session spawned below it (Inherited grants,
  below). Every new grant is this session only, card-only keys included; passing
  one down is always the user's explicit choice. The card's "Approve for
  session" grants this session only, and the menu beside it offers both scopes;
  that one choice applies to every key the card grants
  (`resolveApproval.grantInheritable`, ignored without `forSession`). The
  inspector's Allow… dialog has a box for the same choice, unticked by default
  (`grantApprovalForSession.inheritable`).
- **Re-granting only widens.** Approving for session a key the session already
  holds keeps the original grant (its time and source card) and widens it when
  the user chose "the sessions it starts". It never narrows one: that is an
  explicit scope change in the inspector.

- **Coverage.** A new card runs on its own only when EVERY key it performs is
  granted. A mixed Jira or Confluence batch with one ungranted operation waits
  for a click like any other card. A card that performs nothing is never
  covered.
- **The card still exists.** A covered card is created, stored and shown with
  `autoApproved: true`. It does not mark the session as waiting and raises no
  push.
- **When it runs.** Never inside the proposing tool call: that turn may still
  hold what the executor needs (a default-branch merge reserves the very
  worktree the turn runs in). It runs on the session's next idle edge
  (`runAutoApprovals`, from the idle hook in `index.ts`), before queued handoffs
  drain, through the same `prepare`/`execute` path as a click. A session's
  covered cards run oldest first. Each card's outcome goes into the durable
  handoff queue (`enqueueAgentHandoff`) in the same synchronous step that
  records the card as terminal, with no await in between. A later card that
  hangs, or a graceful restart, therefore cannot lose it; only a hard kill
  between those two synchronous writes could. If the queue refuses the write,
  the card keeps its status and shows that the agent could not be told. Delivery
  starts only after the whole batch, because delivering an outcome starts the
  agent's next turn. Boot resumes the covered cards a restart left pending, one
  batch per session; a card already executing is not retried.
- **Other turns during a batch.** Holding delivery back only stops the batch's
  OWN outcomes from starting a turn. Anything else that can start one still
  does: a prompt from the user, a peer prompt, a background completion, or
  another decision's handoff. That is deliberate. Holding the handoff queue for
  a batch would not stop the other sources, and it would make the user's own
  answers wait behind executors that can run for minutes. An executor that needs
  the session idle refuses safely instead, exactly as it does for a clicked
  approval: a default-branch merge that finds its worktree busy merges nothing,
  and the card fails with that reason.
- **Revoking.** Revoking removes the grant; a card already executing finishes. A
  covered card that has not started yet is re-checked under its decision lock,
  before and after `prepare`, and with its grant gone becomes an ordinary
  pending card. A `prepare` refusal does the same, with the reason on the card.
- **Lifetime.** Grants are stored beside the cards (see Storage) on the session
  that was granted them, and last until revoked. They reach no unrelated
  session. A session spawned below the holder inherits the ones passed down
  through a live lookup (Inherited grants, below); nothing is copied to it.
- **Where the user sees them.** The card that created a grant shows it, with its
  scope, and Revoke. The session inspector's Approvals section lists them all,
  each own grant with its scope and a control to pass it down (confirmed) or
  keep it to this session; one section action does either for all of the
  session's own grants at once. The server sends the session's full list as
  `approvalGrants`, empty included, when a session is viewed and after every
  change; `revokeApprovalGrant` withdraws one key, and
  `setApprovalGrantScope { sessionId, keys, inheritable }` sets the scope of the
  session's own grants named in `keys`, ignoring keys it does not hold.
  Narrowing works like a revoke for the sessions below: a covered card there
  that has not started is handed back by the same re-check.

### Inherited grants

A spawned session's card is covered when every key it performs is held by the
session itself, whatever the scope, or held as inheritable ("the sessions it
starts") by an ancestor on its spawn chain. Each key may have a different
holder, so a mixed Jira batch can be covered by one ancestor's `jira:comment`
and another's `jira:edit`.

- **Live lookup, nothing copied.** Creation and both re-checks before a covered
  card runs (before and after `prepare`) call the same lookup (`grantCoverage`
  in `pendingApprovals.ts`), which walks the `spawned` edges up from the session
  (`sessionStore.spawnGrantAncestors`, one indexed edge read per level) and
  reads each session's grants. Nothing is cached between checks. No grant row is
  ever written for a descendant, so revoking or narrowing on the holder is the
  whole change: the next check of every descendant sees it, and a covered card
  that has not started is handed back exactly as for a local revoke.
- **Only what the user passed down.** An ancestor's grant counts only when it is
  inheritable. That holds for every key, card-only ones included
  (`managedPullRequestMerge`, `githubBranchDelete`, `forgejoRelease`, the
  Confluence deletes, `gitTag:*`) and `sessionSpawn`, `projectCreate` and
  `agentDefinition`: a merge grant stays with the session that received it
  unless the user passes it down, and then a descendant can merge into the
  default branch without asking. Keyless kinds (`settingsInput`,
  `managedCommitOverride`) stay uncovered. The edge's owner is never read:
  coordinator-owned, born user-owned and taken-over children all inherit. An
  agent definition's denied tools still apply.
- **Nearest holder.** The session's own grant wins, then the nearest ancestor
  holding the key as inheritable. An ancestor's session-only grant of the key is
  skipped, not a stop: a farther ancestor's inheritable grant still covers. One
  helper (`inheritedGrants` in `pendingApprovals.ts`) applies this rule for both
  coverage and the inspector, so they cannot disagree. The holder it finds is
  what the inspector shows and what the card records.
- **Where the walk stops.** At a session nothing spawned, at an edge spawned
  with `inheritGrants: false`, at a soft-deleted parent (the user can no longer
  open it to revoke), or at a session already visited. An archived ancestor
  still counts. A purged session's edges go with it (FK cascade).
- **Opting out.** A `session_spawn` row (`spawn` or `propose`) with
  `inheritGrants: false` creates a session nothing above it reaches, nor its own
  spawns through it. Its OWN inheritable grants still reach its descendants. A
  row that does not set it takes its agent definition's `inheritGrants`
  ([agent-definitions.md](agent-definitions.md#the-file)), else inherits; an
  explicit row value always wins. The choice is fixed at spawn: the propose card
  shows "Won't inherit your approvals" on such a row but does not offer to
  change it, and Take over / Hand back keep it.
- **Edges from before inheritance inherit.** An edge with no flag inherits, so
  peers spawned before this shipped, reviewers included, started inheriting on
  deploy. Revoke on the ancestor to stop it.
- **In the inspector.** The `approvalGrants` frame carries the session's OWN
  list in `grants` (the only one its cards and the inspector revoke from or
  rescope), `inherited` (each key an ancestor passes down, with `heldBy` the
  nearest such holder, own keys included) and `inheritance`
  (`{ parentSessionId, inherits }`, for a spawned session). An inherited row
  reads "Inherited from <session>" and has no Revoke or Allow; an own grant an
  ancestor also holds keeps Revoke and says it is still covered by that
  session's grant until revoked there; an opted-out session says it does not
  inherit. Every grant or scope change on a session that changes something
  re-sends the lists of that session and of every session spawned below it,
  built from one per-call memo so each session's grants and each edge are read
  once. Deleting an ancestor sends nothing: coverage refuses at once, and the
  list catches up on the next view or grant change.
- **On the card.** An auto-approved card covered by an ancestor's grant carries
  `inheritedGrants: [{ key, fromSessionId }]`, one entry per key a session other
  than its own covered, and shows "Covered by <session>'s grant". It is set at
  creation, re-stamped from the holders that still stand when the card starts
  executing, cleared when the card is handed back, and never set on a clicked
  approval.

## Storage

Cards live in the `approvals` table and grants in `approval_grants` (migration
0063, `db/approvalStore.ts`). A card row holds the card and its execution
context as JSON, exactly as the old file did, plus the columns reads select by:
`session_id`, `status`, `auto_approved` and `created_at_ms`. `seq` is insertion
order for both tables, so a session's cards and grants come back oldest first.
The pending cards have their own partial index. The attention set, a session's
auto-approval batch and supersession read only pending rows. Showing a session
reads only its own cards, while its grant view also looks up live grants on
inheriting ancestors. A patch that leaves a card unchanged writes nothing.
Granting a key the session already holds keeps the original grant, widening its
scope when asked.

A grant's scope is `approval_grants.inheritable` (migration 0091,
`INTEGER NOT NULL DEFAULT 0`). No row was rewritten: a grant stored before the
column existed reads as this session only, so after that deploy the descendants
of older sessions stopped inheriting those grants until the user passes them
down. `setGrantInheritable` updates one row by its `(session_id, key)` unique
index.

The spawn-edge opt-out adds no table. It is `"inheritGrants": false` in the
spawned edge's `session_links.metadata_json`, written only when false.
`parseSpawnInheritance` (`db/sessionStore.ts`) fails closed: SQL NULL and a JSON
object without the property inherit; invalid JSON, JSON `null`, a scalar, an
array and any present value other than the written `false` (even `true`) do not.
`setSpawnedOwnership`, the one metadata rewriter, writes the opt-out back
whenever the old metadata did not inherit, so a corrupt edge becomes a
well-formed non-inheriting one.

`reconcileLegacyPartialApprovalCard` still runs on every read, as it did on
every read of the file, so a card stored in the old partial-failure shape reads
repaired.

Until 0063 both lived in `DATA_DIR/pending-approvals.json`, read and rewritten
whole. A one-time boot import moved them into these tables and renamed the file
to `pending-approvals.json.imported-<ms>.bak`. That importer is retired, like
the pull-request cards' one ([pull-requests.md](pull-requests.md#storage)): the
server neither reads nor deletes a leftover `pending-approvals.json`.
