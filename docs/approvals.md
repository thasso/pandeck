# Approvals and session grants

Every agent-proposed mutation that needs the user's consent goes through one
approval card (`app/server/src/pendingApprovals.ts`, `ApprovalCard` in
`app/shared/protocol.ts`). The agent's tool creates the card and ends its turn,
the user answers, the server executes, and the outcome reaches the agent as a
hidden prompt through `agentHandoffs.ts`.

## The cards

| Card kind                 | Raised by                                                 | Grant keys                                              |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `githubPullRequest`       | `github_{create,edit,review,comment,assign}_pull_request` | `github:create` … `github:assign`                       |
| `githubIssue`             | `github_mutate_issue`                                     | `githubIssue:create` … `githubIssue:label`              |
| `githubBranchDelete`      | `github_delete_branch`                                    | `githubBranchDelete`                                    |
| `forgejoPullRequest`      | `forgejo_{create,edit,review,comment}_pull_request`       | `forgejo:create` … `forgejo:comment`                    |
| `forgejoRelease`          | `forgejo_create_release`                                  | `forgejoRelease`                                        |
| `jiraIssue`               | `jira_mutate_issue`                                       | `jira:edit`, `jira:create`, `jira:comment`, `jira:rank` |
| `confluencePage`          | `confluence_mutate_page`                                  | `confluence:create`, `…:edit`, `…:comment`, `…:delete`  |
| `tempoWorklog`            | `tempo_mutate_worklogs`                                   | `tempo:create`, `tempo:update`                          |
| `gmailArchive`            | `google_gmail_archive`                                    | `gmailArchive`                                          |
| `sessionSpawn`            | `session_spawn` with `operation: "propose"`               | `sessionSpawn`                                          |
| `managedPullRequestMerge` | `worktree_finish_pull_request` into the default branch    | `managedPullRequestMerge`                               |
| `projectCreate`           | `project_create`                                          | `projectCreate`                                         |

The `commit` kind remains readable for stored cards; nothing creates it today.

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

## Superseded cards

A proposing tool can pass `supersedes` to `createApproval`. In the same store
write that adds the new card, every still-pending card of the same session that
matches becomes `superseded` (with `supersededBy`): it leaves the pending strip,
stops marking the session as waiting, and can no longer be decided. A card with
a decision in flight is never superseded. The agent gets no outcome for the old
card; the new card's outcome answers both.

`managedPullRequestMerge` supersedes an earlier card for the same provider,
repository and pull request number, so re-staging a merge after new commits
leaves one card to approve.

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
Every card kind offers the button.

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
- **Lifetime.** Grants are stored beside the cards (see Storage) and last until
  revoked. They never reach another session, including a peer the session
  spawns.
- **Where the user sees them.** The card that created a grant shows it with
  Revoke. The session inspector's "Approved for session" section lists them all.
  The server sends the session's full list as `approvalGrants`, empty included,
  when a session is viewed and after every change; `revokeApprovalGrant`
  withdraws one key.

## Storage

Cards live in the `approvals` table and grants in `approval_grants` (migration
0063, `db/approvalStore.ts`). A card row holds the card and its execution
context as JSON, exactly as the old file did, plus the columns reads select by:
`session_id`, `status`, `auto_approved` and `created_at_ms`. `seq` is insertion
order for both tables, so a session's cards and grants come back oldest first.
The pending cards have their own partial index. The attention set, a session's
auto-approval batch and supersession read only pending rows, and showing a
session reads only its own cards and grants. A patch that leaves a card
unchanged writes nothing. Granting a key the session already holds keeps the
original grant.

`reconcileLegacyPartialApprovalCard` still runs on every read, as it did on
every read of the file. The import also stores its result, so the repair is
persisted rather than re-derived.

Until 0063 both lived in `DATA_DIR/pending-approvals.json`, read and rewritten
whole. The server imports that file once and renames it to
`pending-approvals.json.imported-<ms>.bak`, never deleting it. The crash,
replaced-file, duplicate, bad-file, unavailable-store and rollback rules are the
pull-request cards' ones ([pull-requests.md](pull-requests.md#storage)). A
repeated card id, or a repeated grant for one session and key, keeps the first
and stays in the backup. An unavailable approval store refuses reads, and so
refuses to answer "no grants", rather than auto-approving nothing or everything
on a guess. A store written before grants existed imports its cards and no
grants. A card with no body, or one reconciliation cannot read (a Jira body
without usable items), counts as invalid and is left in the backup. The rest of
the file imports. In the file store such a card made every read fail and the
store read as empty.
