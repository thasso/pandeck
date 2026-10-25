# Pull requests

## Host command

Coding sessions (`workshop` and `developer`) expose:

```text
/pr [--draft] [--base <branch>] [--force] [--force-commit] [context]
```

The command is host-driven and harness-independent. It runs the same commit and
push workflows as `/commit` and `/push`, then opens or reuses a pull request.
Each non-skipped phase is a separate synthetic tool turn, so commit and push
retain their ordinary transcript cards rather than being collapsed into one
opaque operation.

The phase contract is:

1. **Commit.** A clean working tree skips the phase and renders no commit card.
   Otherwise `/commit` stages all changes and runs its safety review. A blocked
   or failed commit stops the chain; only the explicit `--force-commit` option
   overrides that review.
2. **Push.** A branch equal to its upstream skips the phase. A normal push uses
   the branch upstream or `origin`; `--force` means `--force-with-lease` and
   does not weaken commit review. A failed push stops the chain. An up-to-date
   result renders no push card.
3. **Pull request.** The hosting provider is resolved from the checkout's
   `origin` push URL, so the command works in ordinary repositories as well as
   registered worktrees. An existing pull request for the head branch is reused,
   regardless of whether it is open, closed, or merged; the command never
   duplicates it. Reused closed/merged PRs are warning-toned and explicitly
   state that no new PR carries the branch's latest commits.

The selected remote's push URL governs provider identity consistently for `/pr`,
the card watcher/actions, and worktree hosting status; a configured `pushurl`
therefore moves the whole PR/CI lifecycle to that publication repository rather
than splitting creation from observation.

Every successful push card (`/push`, the `/pr` push phase, `worktree_push`)
links the branch's page on its hosting provider and, when the branch already has
a pull request in any state, that pull request. The links are resolved once when
the push finishes, through the same push-URL provider resolution; an
unconfigured provider, a failed lookup, or one slower than five seconds drops
the link rather than the card. A pull request created later does not update an
earlier push card. Only a branch the push provably updated is linked: a
source-only refspec counts when its source resolves to a local branch and no
`remote.<name>.push` mapping applies, and an explicit `src:dst` only when `dst`
is a full `refs/heads/` ref. Anything else (a tag, a deletion, an unqualified
destination git may resolve to a tag) omits the links.

The provider base branch comes from explicit `--base`, then the session worktree
row's `baseBranch`, then `origin/HEAD`. Coding agents can change a spawned row's
future target with `worktree_set_base`; that metadata operation does not rebase
the branch or retarget an existing provider pull request, and its result warns
when an open managed card still targets another base and names
`worktree_retarget_pull_request` (below) as the step that moves it. Workflow
publication calls the same card creation/adoption seam with its Task and base
made explicit, so it cannot stop on the multi-Task chooser. Its card omits
`sourceToolCallId` because no slash command turn exists; it still belongs to the
implementer session and is injected into that transcript by creation time. The
agent's git range separately prefers `refs/remotes/origin/<base>` over a local
branch so a stale local main does not pollute the PR body. A detached HEAD or an
unresolved base is an error. GitHub receives `draft: true`; Forgejo represents a
draft by prefixing the title with `WIP:`.

## Agent-facing managed commit scope

`worktree_commit` commits the complete change set by default: the workflow runs
`git add -A` and reviews every tracked change and non-ignored untracked file,
exactly like `/commit`. With `stagedOnly: true` the index is the change set: the
caller stages its own paths with `git add` first, and the workflow reviews,
fingerprints, and commits `git diff --cached` as-is — no `git add -A`, no
untracked-file reading, and no deterministic path blocker for anything left
unstaged. Unstaged and untracked paths stay in the working tree; the
commit-message agent is told their count (and up to 40 of their paths) so it
does not describe them. An empty index is the structured
`No staged changes to commit.` blocker, and a drift check under the repository
lock compares only the index, so working-tree edits during message generation
neither block nor enter the commit. The result and card carry `stagedOnly` so a
partial commit is visible as such. This is the tool for a worktree that also
holds changes the caller did not make; `worktree_push` still requires the whole
tree clean, so the leftover changes have to be committed or moved before
publication.

An optional `message` is the caller's own commit message, committed as given
(outer whitespace trimmed, at most 8,000 characters) instead of the generated
one. It is committed with `--cleanup=verbatim`, as is an approved override's
message, so git's default cleanup or a configured `commit.cleanup=strip` cannot
drop `#` lines or blank runs the caller wrote. The commit-message agent still
runs, because it is the safety review: its blockers and warnings apply unchanged
and only its message goes unused. Without `message` the generated message is
committed as before.

The safety review judges secrets only by what the commit records: the patch,
untracked file content and paths. Session prompts, Tasks and caller context are
review context, never committed, so a credential pasted there (temporary AWS
keys, tokens) is masked before the commit-message agent sees it and is not a
blocker. A caller-written `message` is the opposite case: it is published as
written, so it gets the same credential check as the patch's added lines
(`textLooksLikeCredential` in `credentialRedaction.ts`: private keys, known
token shapes including JWTs, Authorization/Bearer headers, quoted credential
assignments and long standalone unquoted shell credential literals). A hit
refuses before the worktree is read, and there is no override, `force` included.

### Commit review override

When the review blocks and the agent has a reason to proceed, `worktree_commit`
with `force: true` and a required `reason` asks the user instead of committing.
The call runs the ordinary unforced review as a dry run and commits nothing. A
passing review, an empty change set, a secret finding, or an unresolved merge
conflict or merge/rebase in progress refuses with an error and creates no card;
those cannot be overridden. Any other blocker creates a one-shot
`managedCommitOverride` card ([approvals.md](approvals.md#the-cards)) bound to
the worktree, its path and branch, the change fingerprint, `stagedOnly`, and the
proposed message (the caller's `message` when given), and the tool ends the
agent's turn. A newer override from the same session for the same worktree
supersedes a pending one.

On approval the server reserves the worktree (refusing while it is busy),
re-checks that the managed row is still active at the same path and branch and
that the branch is checked out, then re-runs the review with force. A fresh
secret or conflict still refuses, the change fingerprint must still match, and
only the approved message is committed. Rejecting changes nothing. Either
outcome reaches the agent through `agentHandoffs.ts`. The card is never covered
by a session grant.

## Checked tag publication

`git_publish_tag` is a deferred coding-persona tool for ordinary repositories
and managed worktrees, including main checkouts. It stages an approval card for
the exact absolute checkout path, tag, commit, tracked branch and push
destination. Nothing is written until the user approves; on approval, the
executor rechecks the checkout and destination. A session-wide grant covers only
the same checkout, destination, tag and commit. Pandeck's own releases are
published with this tool (`docs/ci-cd.md#cutting-a-release`); for a Forgejo
repository whose releases carry notes, `forgejo_create_release` creates the
annotated tag and the release together.

The tool creates a lightweight tag at the checked-out HEAD and pushes only that
tag to the branch's single upstream push URL, disabling follow-tags and
submodule pushes. The checkout must be clean, on a branch tracking a same-named
remote branch; local HEAD and the authoritative remote branch head must match
the approved oid. Git validates the name; existing local or remote tags pointing
elsewhere are refused. An already-published tag at the approved oid is a
read-only retry even if the checkout moved. There is no force, tag movement,
arbitrary remote/ref argument or implicit branch push. Local ref creation takes
the repository lock. If a push fails after creation, the local tag remains for a
safe retry. A concurrent remote branch rewrite between the remote-head check and
tag push cannot be ruled out; the approval pins the commit, not a future branch
state.

## Agent-facing managed creation

Coding personas also have deferred `worktree_create_pull_request`, the third
checked managed-delivery step after `worktree_commit` and `worktree_push`. It is
an external side effect available in Build mode, not Plan mode, but requires no
approval or extra confirmation: the server admits only an active registered
spawned worktree and derives every dangerous value. The input has only its id,
an optional exact linked Task id, bounded authoring context, an optional title
and body, and `draft`; it has no path, provider/repository, remote, ref, or SHA.
A supplied title is trimmed only at its outer whitespace and must remain
nonblank, one line, and at most 120 characters. A supplied body is trimmed the
same way and may be up to 65,536 characters, GitHub's own cap. Both are accepted
as caller-authored policy — no Jira-key, conventional-commit, or
repository-specific rewriting or enforcement is applied.

Caller text widens what an agent can publish very little: it already publishes
whatever it writes into files and pushes. What guards publication is the secret
check, so a caller title or body gets the same check as a caller commit message
(see "Agent-facing managed commit scope"): a hit refuses before the worktree is
read, with no override.

The caller-aware worktree mutation reservation is held from revalidation through
provider post-read. Under it the service requires the persisted path, project,
branch, and base to remain unchanged; the checkout must be on that branch, at a
readable clean HEAD; the branch must track the derived remote's same branch
name; and an authoritative `ls-remote` oid must equal local HEAD exactly. The
hosting provider is resolved from that remote's **push URL** and its parsed
repository identity must match, so an upstream on a fork cannot accidentally
create against `origin`. A missing or unequal remote head is a refusal to use
ordinary `worktree_push`, or exact `forceWithLease` only after an intentional
rewrite. The tool never commits or pushes implicitly.

Task candidates come only from the target worktree, never the caller session.
Zero links creates without Task context, one is selected, and several are
returned as a bounded refusal for retry with an exact linked id; this path never
creates a human `choosing-task` interruption. The canonical card still belongs
to the caller session and is anchored at the calling tool id, while its
`worktreeId` names the target checkout so later card actions remain correct.
Retry recovery is scoped to that caller timeline to preserve its tool-call
anchor. An explicit title and body are persisted in the card's server-only
authoring context before drafting/provider creation. While that card is still
pending AUTHORING (`creating`), recovery requires the retry to carry the same
title and body intent, including the distinction between omission and an
explicit value, rather than silently replacing or dropping it. Once the card
represents a provider pull request, later title input is ignored and the
provider title is adopted without mutation. A later call from another session
may project the same provider PR into that session too, matching repeated `/pr`;
provider mutations remain serialized across cards. For a newly created pull
request, the same bounded configured PR agent described below writes whatever
the caller left out: the caller's title and body win where given. With both
given the agent does not run at all, so the card carries no authoring warnings;
with either missing it runs as before and its warnings are kept. An adopted pull
request keeps its title and body; `worktree_update_pull_request_body` changes
the body afterwards.

Existing branch PRs are adopted only after provider detail proves the expected
provider repository, head branch, base branch, and, for an open pull request,
the accepted head SHA. A merged or closed pull request is adopted as the honest
terminal lifecycle answer regardless of later branch movement; no replacement is
opened silently. New PR creation allows the worktree's recorded base even when
it is the repository default branch. The provider is read back after creation.
External movement in the create/read interval cannot undo the landed PR, so the
card remains visible with a prominent `STALE-HEAD WARNING` and the tool returns
partial success instead of claiming the accepted SHA is still its head. Success
invalidates worktree hosting/status caches and schedules the live card watcher
immediately. This pre-authorization ends at creation: it never permits merge.

The generic `github_create_pull_request` and `forgejo_create_pull_request` tools
remain approval-gated because they accept arbitrary repositories, refs, and
authored content. `github_edit_pull_request` and `forgejo_edit_pull_request`
replace the complete description of an existing PR (an empty body clears it),
retarget it onto another `base` branch, or both; at least one is required. They
also require approval; they accept a repository and PR number, not a
managed-worktree identity. An approved base goes through the provider's
`retargetPullRequest` under the pull request's hosted mutation lock (see "Card
actions"); a description uses the provider's body-only PATCH without the
retarget lock, and one that fails after the base landed names the retarget as
already applied. `github_ready_pull_request` and `forgejo_ready_pull_request`
are approval-gated draft-to-ready transitions by repository and PR number. The
approved executor re-reads the PR and refuses a closed or already-ready PR.
GitHub uses its GraphQL ready-for-review mutation; Forgejo removes the `WIP: `
or `[WIP] ` title marker through the provider seam. Neither tool merges or
promises green checks. `github_close_pull_request` and
`forgejo_close_pull_request` are the approval-gated close for any pull request
by repository and number, with the same optional `comment` and opt-in
`deleteBranch` as the managed close. The proposal reads the pull request,
refuses one that is not open, and binds its head SHA; the approved executor
closes through the same provider `closePullRequest` under the hosted mutation
lock, so a pull request pushed to while the card waited is refused. Their grant
keys (`github:close`, `forgejo:close`) are card-only. `/pr` remains the human
all-in-one commit/push/create command and keeps its session-derived Task chooser
behavior.

All generic PR writes, including create, edit, ready, close, reviews,
comments/replies, GitHub reviewer/assignee changes and thread resolution, use
`GitHostingProvider` through `hostingProviderFor({ service, owner, repo })`,
which snapshots the selected integration's current tool settings at execution.
It does not detect a remote, select another account or fall back to the other
service. Managed paths keep `hostingProviderForRepo`, resolved from the
checkout's selected push remote. The adapter constructors are private. Approval
gating, result wording and API URL overrides remain tool-owned. Every GitHub
port mutator drops provider annotations in `finally`, including standalone
comments, failed writes and same-state thread operations. The generic executor
separately invalidates PR inventory in `finally`, except for standalone timeline
comments and review replies. A close with an internal comment still invalidates
inventory as one close operation. Managed paths additionally own card
projections and read-back.

Both adapters support review submission and timeline comments. GitHub supports
replies to numeric review-comment ids, reviewer users/teams, assignees and
guarded thread resolve/reopen. Forgejo instead supports file/line-anchored
comments on an existing review. Those distinct reply and assignment/thread
operations are optional port methods; a missing capability fails before any
write, with no raw fallback. Assignment orchestration stays in the tool: request
reviews, cancel review requests, assign, then unassign, skipping empty lists and
preflighting all needed capabilities before the first request. A failure names
only the earlier confirmed steps.

Each adapter shares one private timeline-comment HTTP transport between
standalone comments and close. Response policy remains caller-specific: a
generic write rejects literal JSON null and retains explicit empty API URLs,
while close counts a successful comment POST as posted even without a usable
URL. Close keeps its token guard, head proofs, confirmation/deletion lifecycle
and single outer annotation-eviction boundary. Newly port-backed Forgejo
review/comment writes still attempt anonymous HTTP when no token is configured;
close refuses before any read. The approval store continues to omit empty result
URLs.

These writes use the port's eight-second per-request deadline, not an overall
operation deadline. No write retries automatically. A create accepted remotely
just before a timeout can exist even though its approval failed and its number
is unknown. Inspect current pull requests for that repository/head before
retrying, rather than treating failure as proof that nothing happened. Re-read
an edit or ready transition whose outcome is uncertain too. Likewise inspect
reviews, comments and people lists before retrying a failed review/comment or
partial assignment: a timed-out step may have landed, and repeating a comment
can post it twice. Close retains its separate confirmation and recovery behavior
below.

## Agent-facing managed body update

`worktree_update_pull_request_body` replaces the description of a worktree's
canonical open pull request after it exists, typically when a fix round changes
a decision the body records. It takes an active spawned-worktree id and either a
caller `body` (validated and secret-checked exactly like creation's) or nothing,
which asks the PR draft agent to write the body again; an optional `context`
guides only that regeneration. It is pre-authorized like the ready and retarget
transitions and resolves its target the same way: the push repository, the ONE
open pull request for the branch, and a live managed card anchored to this
worktree, with no card owned by another worktree. It accepts no repository, PR
number or ref, so it cannot reach another repository or pull request; the
approval-gated `github_edit_pull_request`/`forgejo_edit_pull_request` remain the
way to edit anything else.

Regeneration reads the local branch, so it requires local HEAD to equal the pull
request's head; otherwise it refuses and asks for a push. The draft agent sees
the same sections as at creation, with the Task linked on the worktree's card.
Its title is unused and its warnings are returned.

Under the per-PR mutation lock the tool re-reads the pull request and refuses if
its state, head, head branch or base moved, reads the current body (an identical
one writes nothing but is still projected onto the cards, which repairs a card
an earlier partial update left stale: `unchanged`), PATCHes the body, and reads
it back. Neither provider has a precondition on that PATCH, so a failed write is
judged like a retarget: a read-back showing the old body is the provider's
refusal, the new body is success with a warning, anything else is an "outcome
unknown" error. A successful write whose read-back differs or cannot be read is
`updated-partial`. Only a confirmed body is projected onto the live cards.

## Repository pull-request capabilities

What a repository ALLOWS is read from provider metadata, never assumed:
`GitHostingProvider.repositoryCapabilities()` answers the exact
provider-reported default branch, the merge methods the repository permits (in
the shared `squash | merge | rebase` order), a provider/project default method
only when metadata defines one, close support, and branch-deletion facts. GitHub
maps `allow_squash_merge`/`allow_merge_commit`/`allow_rebase_merge` and
`delete_branch_on_merge`; Forgejo has its own spelling, verified against the
configured API v1 — `allow_squash_merge`, `allow_merge_commits`, `allow_rebase`,
`default_merge_style`, `default_delete_branch_after_merge`. Forgejo's
`allow_rebase_explicit` (rebase then merge commit) has no word in the shared
vocabulary and never enables `rebase`.

An allow-flag the repository payload did NOT carry is neither a permission nor a
denial: it is metadata that could not be read, so one missing flag leaves the
whole supported set unknown (with the field names in its reason) rather than
letting a response that carries only `default_branch` advertise all three
methods. The default branch and close support are read from their own fields and
stay usable.

`repositoryCapabilitiesFor` caches and coalesces the read per repository on a
short TTL; `invalidateRepositoryCapabilities` drops one or all. A read that
FAILS is unknown-with-a-reason and is deliberately not cached. Absence means
unknown at every consumer — never "all methods are supported" and never a
guessed `main`/`master` — so direct merge, default-branch classification and
closing all fail closed. The capabilities are projected into the live card, the
worktree hosting payload and the check-watch result, so both the human merge
pickers and an agent see the current set before choosing; the picker offers only
those methods, offers none while they are unknown, and invalidates a stale
selection when the set changes. Runtime revalidation at merge time is
nevertheless authoritative over anything a surface displayed, and it lives in
the shared merge seam rather than in any one caller:
`mergePullRequestAndProject` takes a FORCED capability read — one that can
neither be served from the cache nor adopt a request that was already in flight,
because a read started before this merge took the lock describes the world from
before it — and refuses a method the repository does not currently allow, or an
unknown set. Every merge surface (the live card, the worktree page's HTTP route,
the managed tool, an approved default-branch merge) passes that guard, so a
picker rendered before the repository turned a method off cannot merge with it.
The managed tool keeps its own earlier check, which reports the supported set
and drives the default-branch classification.

The capability read happens BEFORE the pull request's identity is re-read, never
after: it is a network round trip, and anything learned in it must not sit
between the identity check and the provider call, where a retarget would keep
the accepted head, satisfy the provider's own precondition and land on a base
nobody classified. The pull request's identity is the LAST thing read before
merging — inside the provider too. GitHub used to fetch the pull request again
at the top of `mergePullRequest`, purely to learn which ref to delete after
merging, which reopened exactly that window whenever branch deletion was on (the
managed default). The seam therefore hands the provider the head branch its own
identity read PROVED, and the provider then reads nothing before merging. The
native stack read ([Native stacks](#native-stacks)) sits on the same side of
that line as the capability read: one detail read and one member read, BEFORE
the identity read, which then binds the stack it reports against them.

A caller that could NOT prove it — a human click whose provider could not be
re-read — states nothing about the branch, and the provider reads the pull
request once instead. That read is not conditional on the delete choice or on
which provider is in use: it is where the decided base is bound (no merge API
has a base precondition, so a same-head retarget is invisible to the merge
itself) and where the head precondition comes from when the caller has none. A
pull request that has moved off the decided base refuses there, and one that
reports no head commit refuses too, because a merge conditioned on nothing is
the window all of this exists to close.

Every merge therefore carries an exact head precondition — `sha` on GitHub,
`head_commit_id` on Forgejo. An ordinary card click has no REVIEWED head, but it
has the head the seam just validated, and that is what it merges against, so a
push landing in the final window is refused by the provider rather than merged
silently. What remains is the window inside the merge call itself, which no API
closes for the BASE: the head is covered by that precondition.

A MANAGED caller additionally states what it decided — whether this base was the
default branch, the default branch that judgement was made against, and the
supported set a human approval was answered with — and the seam revalidates all
three against that same fresh read. Those facts are what separate a
pre-authorized merge from one that needs a human, so a default branch that moved
onto this base refuses a direct merge, and an approval refuses once its base is
no longer the default or its offered set changed. Ordinary human merges state no
decision and stay direct.

## Agent-facing managed draft to ready

`worktree_ready_pull_request` is the checked step between managed PR creation
and merge for a draft PR. It accepts only an active spawned-worktree id and is
pre-authorized like managed creation. It derives the push repository and unique
open PR from the worktree, requires a matching live managed card, and re-reads
its head, base and draft state under the per-PR mutation lock before publishing.
It clears draft-era mergeability, rotates card observation tokens so an
in-flight draft poll cannot overwrite the transition, invalidates PR inventory
caches, and schedules an immediate watcher poll. If card projection or cache
invalidation fails after the provider accepts the write, the tool reports
partial success rather than claiming the PR stayed draft. The watcher also
clears draft on later provider observations, including PRs made ready in the
provider UI or through the generic tools. A ready transition does not establish
merge readiness: the agent must inspect the exact-head check watch before
calling `worktree_finish_pull_request`. This tool uses the same GitHub and
Forgejo provider methods as the app's publication flow.

## Agent-facing managed base retarget

`worktree_retarget_pull_request` moves a worktree's canonical open pull request
onto the row's recorded base — typically after a stacked parent merged and
`worktree_set_base` named the new target. It accepts only an active spawned
worktree id and is pre-authorized like the ready transition; the base always
comes from the row, never from the caller. It resolves the same unique open PR
and live cards as finishing, except that the PR's and the cards' base may differ
from the row's (that difference is what it settles); head branch and card
ownership must still match. Under the per-PR mutation lock it re-reads the PR,
refuses a moved head or base, and calls the provider's `retargetPullRequest`.
Neither provider has a precondition on that PATCH, so the result is read back
whether or not the write reported an error: a lost response may hide a write
that landed. A failed write whose read-back still shows the old base is the
provider's refusal; one that shows the new base is success with a warning; any
other answer, or no read-back at all, is an "outcome unknown" error that tells
the agent to read the pull request before retrying. A successful write whose
read-back reports another base, a moved head, or a closed or merged pull request
is a `retargeted-partial` with no card projection, left to the watcher. A
confirmed retarget sets the cards' base (card and context), clears mergeability
and conflicts, rotates the observation token and schedules an immediate poll. A
PR already on the row's base writes nothing and only repairs cards that still
name another base. A base missing on the remote is the provider's refusal,
reported with a hint to push it. The new base re-decides checks, review and
mergeability, and the retarget does not rebase, so the agent re-watches checks
before `worktree_finish_pull_request`.

## Agent-facing managed merge and close

`worktree_finish_pull_request` is the last managed-delivery step, an external
side effect available in Build mode. Its input is a worktree id, an `action` of
`merge` or `close`, a `method` for merges only, an optional `deleteRemoteBranch`
(default true for a merge, false for a close), optional `markTaskDone` and
`removeWorktree` flags (default false, merges only), a bounded `reason` that is
REQUIRED for a close and retained in the tool result and transcript, and an
optional `comment` (closes only) posted on the pull request. It accepts no
repository, provider, pull-request number, ref, SHA, base/default-branch claim,
path or credential; a close that carries merge fields, and a close with no
reason, are refused outright.

After the provider confirms a merge, `markTaskDone: true` applies an ordinary
agent `done` write to the unique Task linked on the managed PR cards, with the
requesting session and reason recorded as answered `statusSuggestion`
provenance. Missing or conflicting card Task links refuse before merging; the
worktree's other Task links never select a different Task. Without the flag the
existing merge-time `done` suggestion stays.

`removeWorktree: true` attempts the ordinary guarded removal, deleting the local
branch without force. The mutation reservation is released first so removal can
take its own stricter hold. Dirty files, unpreserved commits, running sessions
including the caller, pending questions/approvals, or other removal blockers
keep the worktree. Delivered squash/rebase branches use the ordinary delivery
receipt guard. An idle target can be removed from a caller in another checkout.
Neither flag runs before a confirmed merge, nor on a close. Follow-up failures
are independent: Task failure does not skip removal, removal failure does not
undo Task completion, and neither turns a successful merge into an error. The
result stays `merged`, with `followUps.task`, `followUps.worktreeRemoved` when
requested, and `followUps.warnings` explaining incomplete steps. Durable removal
with branch-cleanup failure or directory residue is reported as removed with a
warning, not as a retained checkout.

Default-branch approval cards freeze and show both choices and the selected
Task. The approved executor revalidates that Task identity before merging, then
uses the same follow-up function as direct merges, attributing Task completion
to the requesting agent rather than to the human approver. Its result summary
reports completion, removal and any follow-up warnings. Approval rejection or
failed revalidation performs neither follow-up.

Both actions share one resolution: synthetic main is refused, the active spawned
worktree is reserved with the caller-aware mutation reservation and its row
identity re-resolved under it, hosting is resolved from the derived push
remote's URL and asserted to describe that repository, and the branch must have
exactly ONE open pull request whose provider, head, base and live-card identity
match the managed row. Live cards are found by local checkout and number, so
each card's URL must also name the derived push repository: a checkout that
publishes to two repositories with the same PR number cannot hand one
repository's card to the other's pull request. That count comes from
`findPullRequestsForBranch`, whose open set is PAGED until the provider is
exhausted — a read that cannot be exhausted within its page cap throws instead
of answering, because a truncated page could hide the second open pull request
the invariant exists to catch, and a page whose body is not a LIST throws for
the same reason: a response that could not be understood is not the same answer
as "there are none" — and which reads the newest terminal pull request only when
nothing is open, to say "already merged" rather than "no pull request". Both
providers list pull requests opened from FORKS beside their own and a fork may
carry an identically named branch, so the head REPOSITORY decides which are this
branch's; a head repository that cannot be read (a deleted fork) proves nothing
and is excluded. This multiplicity refusal is local to managed finishing:
ordinary branch status, PR adoption and human merge reads keep using the
tolerant bounded single-result lookup, which is subject to the same
fork/head-repository rule. Provider detail is re-read for an exact non-empty
head and the row-recorded base, and the outward transition runs under
`withPullRequestMutation`, so a card click, an HTTP merge, a second tool call
and an approval cannot both land.

Closing is direct for a default or non-default base. It deliberately requires
neither a clean checkout, remote/local equality, green checks nor mergeability —
the explicit reason is what abandons the work — but it still refuses another
running PA writer and revalidates the exact open pull request and head
immediately before the write. `closePullRequestAndProject`
(`pullRequestClose.ts`) sits beside the merge projection under the same identity
lock: it patches every matching live card to `closed` with the reason, clears
busy/error state (the watcher stops polling a card that left `open`),
invalidates worktree hosting caches, and drives the ordinary workflow
observation with the `closed` outcome. It never suggests the linked Task done,
records a merge, or removes the local branch or worktree. The `reason` stays
Pandeck's record; a `comment` is what the pull request shows. The provider's
`closePullRequest` posts the comment after its head check, then proves the head
again before the state transition, so a push that landed while the comment
posted is refused rather than closed. A comment that cannot be posted refuses
the close. A close request that errors is followed by a read: closed counts as
closed, still open is a refusal, unreadable is an unconfirmed partial. With
`deleteRemoteBranch: true` it deletes the head branch only after a CONFIRMED
close, only when the head is this repository's own branch (never a fork's),
still at the closed head (GitHub: GraphQL `updateRefs` with `beforeOid`;
Forgejo: a tip read before the delete, then a 404 confirmation), no other open
pull request is opened from it (deleting it would close that one too), and no
open pull request targets it as its base. A kept or failed deletion is reported
beside the close, never as a failed close. A close that landed but could not be
confirmed is reported as an honest partial and reconciled by the watcher/boot
paths; its branch is always kept.

Merging first requires a non-draft open pull request, a clean worktree on the
row branch at exact local HEAD, a same-named upstream, and an authoritative
remote head equal to both local HEAD and the pull request head. It then re-runs
the SHARED readiness read extracted from `tools/pullRequestCheckWatch.ts` — a
previous turn's verdict is never trusted — and requires `canMergeNow`; pending,
missing, truncated or failed checks, unknown/false mergeability, unknown review
and changes-requested come back as legible blockers. The requested method must
be in the repository's current supported set, which a refusal reports. The base
is then classified by exact equality with the provider-reported default branch,
never inferred from the local checkout, the row's base naming, `main` or
`master`.

Under the per-PR lock the merge seam re-reads the pull request one last time and
binds what it is merging: head branch, base branch and draft state must still be
the ones the caller decided about. The head SHA alone is not that identity — an
external RETARGET moves a ready pull request onto the default branch while
keeping its exact head, so every head-based precondition (including the
provider's own) would still pass and the merge would land past the approval its
caller classified it out of. A caller that accepted an exact head demands the
current answer and refuses without it; an ordinary card click still merges when
the provider cannot be asked, but never against an answer that contradicts it.

A ready pull request into a NON-DEFAULT base merges directly through
`mergePullRequestAndProject` — the same seam the card and the worktree page use
— attributed to the agent session, and returns the merged state, method, exact
head, branch-deletion outcome, card ids, base/default facts, and the Task
suggestions the PROJECTION reports it actually wrote — never the worktree's
pre-merge Task links, which say nothing about whether a suggestion was written.
The projection asks once per linked TASK rather than once per card (several
cards can name the same pull request and the same Task), and reports a Task only
when that call turned "no standing suggestion" into one: an already-done or
missing Task, a failed write, and a `done` suggestion that already stood all
leave the report empty while the cards still show the Task's current summary. A
ready pull request into the DEFAULT branch performs no provider merge at all: it
creates one `managedPullRequestMerge` approval and ends the agent turn.

The approval card carries frozen decision evidence — worktree/project/
repository/provider, number/url/title, head → base, the provider-reported
default branch, the exact accepted head, the requested method and the current
supported set, the branch-deletion choice, the exact-head check summary, hosted
review, mergeability/draft state, and the linked Task. None of it is trusted at
execution: approving re-derives the COMPLETE common and merge validation against
current state under a FRESH server-side worktree reservation and the per-PR
mutation lock, and refuses (leaving the card answerable again) on a moved head,
a changed base, default branch or capability set, decayed checks or review, a
closed/merged pull request, a busy worktree or any identity mismatch. It notably
re-checks that the base is STILL the default branch, so a stale approval can
never degrade into a direct non-default merge, and it compares the FROZEN
supported-method set with the current one: the user answered "this method, out
of these", so a repository that has since gained or lost any method poses a
different question. On success it merges through the same
`mergePullRequestAndProject` seam and publishes the ordinary approval outcome.
The card is answered as-is; a merge with different settings is a new tool call
rather than an edited approval. A session grant for this operation
(`approvals.md`) answers it on the turn's end instead of a click; the
revalidation is the same.

A GitHub merge the provider ACCEPTED but has not confirmed (see the card actions
below) comes back as `status: "merge-pending"`, the same partial convention as
`retargeted-partial`: the pending reason, no branch or Task outcome, and a
message pointing the agent at the pull-request card, which follows the request
until it turns merged or states its failure with Merge on offer again (see the
card actions below), and telling it to check that before cleaning up. A retry is
safe anyway — it follows the request already running. The approval executor
publishes the same sentence as its outcome and records no merged result. The
completion and cleanup flags (`markTaskDone`, `removeWorktree`) are follow-ups
of a CONFIRMED merge, so a pending one runs neither, on the direct path, the
approval and merge when ready alike, and its message names the ones it did not
do: removing the checkout of a merge that may never land would lose its work.
Merge when ready ends its job with the same `merge-pending` payload; its
outward-step commit has already happened by then, so a stopped job whose wait
was cut short reports pending rather than "not merged". A stacked pull request
above the bottom of its stack is refused by the seam on every path, the approval
and merge when ready included ([Native stacks](#native-stacks)). The stack reads
and that refusal happen before the outward-step boundary, so a refused job
commits nothing. Merge when ready does not yet WAIT for the pull requests below;
it ends with the refusal.

The generic provider PR write tools are unchanged.

### Merge when ready

For a merge, `whenReady: true` first makes the ordinary read-only preflight. A
terminal refusal throws without starting work. If ready and idle, it finishes
inline exactly like the ordinary call. Otherwise it returns `status: "waiting"`
and a visible, stoppable `merge-when-ready` background `taskId`. A task that
already ended before the call returns has `status: "ended"`; its result stays on
that task. A second call cannot start another live job for the same worktree.
Retries of the same call return the existing live task. Completed or missing
rows release that exclusion on the next call.

The job pins the server-derived provider, repository, PR number, branches, exact
head and worktree row. It holds no worktree reservation while waiting. When
checks and hosted review are ready, it takes the caller-aware mutation
reservation and runs the same managed finish core, including fresh local,
readiness, capability and final provider identity checks. It never merges a
replacement PR. A default-branch merge creates its normal approval card at ready
time for the requesting session, with coverage decided by that session's grants
at creation. The job ends reporting the card and `autoApproved`, not claiming
the merge already happened. Job-created cards have no source tool-call placement
because the proposing call has already returned.

Failed checks, requested changes, a moved head, a closed or merged PR,
retargeting, draft state, confirmed conflicts, inconclusive/truncated checks,
the no-checks grace and timeout end without merging. Deterministic refusals at a
final re-read have the same `not-merged` result with
`observedBy: "final-check"`. Low provider budget ends a job that would keep
waiting, but does not block an otherwise ready merge. Unreadable state or a
rejected provider write instead fails the job. A lost provider response may have
landed, so failure never claims `merged: false`. The PR card and watcher
reconcile that uncertainty.

Default-branch classification is live, not pinned when waiting begins. A change
before the managed core's decision is reclassified using current capabilities. A
change between that decision and the merge seam's final read refuses the
operation without merging. Background provider reads before the outward boundary
carry the job's abort signal, so Stop also interrupts slow reads. Foreground
providers do not retain the turn signal: once a convergent write starts it must
finish and project its result even if the turn stops. Background Stop likewise
cannot abort a write after the job's commit boundary.

`timeoutSeconds` requires `whenReady` and bounds only the background wait, not
an inline finish. It defaults to 1800, clamps to 30–7200 and is shortened by the
frozen Settings background lifetime. The clock continues from the first
observation. It is checked before readiness and immediately before the outward
request. Stop prevents a provider merge request or approval creation until that
synchronous boundary. Once a request is sent, Stop cannot abort it or replace
its real result with `stopped`. A Stop that cannot yet confirm completion is
reported unconfirmed. Restart resumes nothing; retained restart delivery tells
the owner the wait ended. Server-task Stop routing is registered at boot,
independently of reconciliation; a task absent from this process can be
confirmed stopped even when reconciliation failed. A requester Stop that wins
after the planned-drain mark keeps its own outcome, not the restart sentence. A
crash after a provider write can still lose its confirmation even if the
provider merged.

The background job carries `deleteRemoteBranch`, `markTaskDone` and
`removeWorktree`. Its removal exempts exactly its own background item, for its
actual owner, from both the settlement gate and tracked-work Stop sweep. Other
jobs, prompted turns and all git guards still block removal. If it removes the
requester's own idle checkout, removal settles that session. Its later
completion wake needs the ordinary missing-worktree acknowledgement; the result
remains on the background task and PR card.

## Native stacks

GitHub stacked pull requests are a provider-native stack: pull requests stacked
bottom to top, each targeting the head branch of the one below, the bottom one
targeting the stack's base. Merging a pull request above the bottom lands the
ones below it too, so a single merge can put several pull requests into the
default branch that no surface showed and no classification covered. This is
step one of supporting them: merging stays safe, and nothing is added to the
decision itself.

`pullRequestDetail` maps GitHub's `stack` object (`githubStackFrom`, the one
place that knows its spelling) onto `PullRequestDetail.stack` (`number`, `size`,
`position` with 1 = bottom, `baseBranch`). A stack it cannot read is
`stackUnknownReason`, never absent: unstacked and unreadable are different
answers, and the second fails closed. `stackMembers` (GitHub only) lists one
stack's members and throws on a body that is not a list or a member without its
number, head or base. The watcher copies `stack` onto the card, which states
"pull request k of n in a stack on <base>; merge the pull requests below it
first" while the card's base is not the stack's.

**Tier A — only single-pull-request merges.** For a provider with native stacks
the shared merge seam reads the pull request's detail and, when it is stacked,
the stack's members, after the capability read and BEFORE the final identity
read (the ordering argument in
[Repository pull-request capabilities](#repository-pull-request-capabilities)).
The identity read must then report the same stack — number, size, position, base
— or the merge is refused as "the stack changed". It refuses, on every entry
point (card, worktree page, PR view, managed tool, approval executor, Workflow
Run):

- a pull request with OPEN members below it, named nearest first, with the
  lowest one to merge first. "Below" is the members listed before it:
  `GET /stacks/{n}` lists them bottom to top, merged ones included, and carries
  no base. `position` and `size` never change as the stack merges down (the top
  of three stays 3 of 3), so only the members' own state says what is left;
- a member below that was closed without merging;
- a pull request whose direct base is not the stack's base (a lower member
  merged and GitHub has not retargeted this one yet);
- a stack or member list that could not be read, a member list that does not
  contain this pull request, and a detail read that failed or answered nothing —
  the stack read or the LAST identity read, its conflict-confirming retry
  included (a retry that fails never falls back to the first answer). Ordinary
  clicks are no exception, although they otherwise tolerate an unreadable
  provider: a stack can be created around a pull request after the evidence was
  read, so the earlier answer never stands in for the last one.

The provider's own pre-merge read, for a caller that could not prove the pull
request, is bound the same way: the seam passes `expectedStack` (`null` = it
proved there is none), and a read that finds any other stack — including one the
caller never bound at all — refuses, like a moved base.

GitHub's legacy `PUT /pulls/{n}/merge` refuses every stacked pull request, the
bottom one included (403, "use the asynchronous merge endpoint"), which is one
reason every GitHub merge goes through `merge-async`. A merged mid-stack pull
request keeps its ORIGINAL `base.ref` although it landed on the stack's base, so
where a merged pull request landed is never inferred from its base.

What is left merges exactly one pull request into its direct base, which equals
the stack's base, so every existing classification (managed direct versus
approval, human direct) holds unchanged and no new UI decision is needed.

Residual window: a stack CREATED over this already-bottom pull request between
the identity read and the provider call needs no retarget and moves no head, so
no precondition covers it. It is the same class as the documented base window
inside the merge call.

After a pull request in a native stack merges, GitHub retargets the one above
onto the stack's base at once and rewrites its head server-side about 8 s later
(rebased onto the new base). A managed worktree for that pull request is then
behind and diverged from its remote, so `worktree_finish_pull_request` refuses
it until the worktree is synced. That is legible, and fixing it is out of Tier
A's scope.

Branch deletion after a confirmed merge is guarded for stacks native or not (see
[Card actions](#card-actions)). Not in Tier A, and the follow-up step: merging a
mid-stack pull request as a human decision — classifying by the stack base and
the member set, an approval that lists every member, and the lower members'
cards projected as merged by the real actor.

## Pull-request draft agent

A dedicated no-tool agent receives bounded `base...head` commit log, diffstat
and patch sections, linked Task titles/descriptions, and free-text command
context. Its system prompt treats every supplied section as untrusted data and
requires exactly one sanitized JSON object:

```json
{
  "title": "Concise title",
  "body": ["Markdown section or paragraph"],
  "warnings": ["Concrete warning"]
}
```

The model slot is independent (`AppSettings.prAgent`) and defaults to the commit
agent's shipped model settings.

The agent's generated title is the default whether or not a Task or Jira issue
is linked. Linked Tasks remain prompt context and card metadata; their Jira keys
and titles never compose, prefix, or otherwise dictate the pull-request title.
The managed creation tool's optional explicit title and body replace the agent's
for a newly created pull request; with both given the agent is not asked (see
"Agent-facing managed creation"). An already-existing provider pull request is
adopted without being renamed. `worktree_update_pull_request_body` without a
body asks the same agent for a new body of an open managed pull request.

Session-linked Tasks are candidates first, in their existing order;
worktree-only Task links extend that list without reordering or duplicates. A
single candidate (or none) is used immediately; several candidates pause the
card for the user to pick one — see below.

## The live card

The pull-request phase renders a durable, LIVE `PullRequestCard`, not a static
terminal one: it keeps changing after creation as CI runs, a review lands, or
the PR merges. It is store-driven (`pullRequestCards.ts`, modeled on the
pending-approvals subsystem) rather than part of the ordinary append-only
timeline, because only a mutable store supports being patched long after the
`/pr` command's synthetic tool turn has already finished:

- The synthetic turn for the pull-request phase finishes with plain text
  (`finishSyntheticTool`), never a rich card — same shape as any other tool.
- The card itself is a separate durable record, re-emitted on attach right AFTER
  the atomic snapshot (mirrors approval cards) and anchored at the `/pr` tool
  call's position via `sourceToolCallId` so it renders right after it rather
  than at the bottom of the transcript. One assistant entry holds a whole turn,
  so placement (`app/shared/cardPlacement.ts`, shared by the client and the
  server snapshot) splits that entry after the call and continues the rest of
  the turn below the card, live and after reload alike. Claude tools learn the
  call id from the CLI's `_meta["claudecode/toolUseId"]`; without it the anchor
  names the MCP request number and the card falls back to its creation time.
  Since it is not IN that snapshot, a snapshot for the session already in view —
  a reconnect, a cache-bearing reload — keeps the client's cards instead of
  blanking them: clearing them unmounts every card in a transcript whose other
  rows all stay, which reads as one card blinking on its own and loses the local
  state of the control the user is using (`useAssistant`'s `snapshot` case).
- Every change (task pick, drafting, CI, review, merge) broadcasts
  `pullRequestCardUpdate`, and the client upserts the card by id.
- Workflow publication reuses a matching live card for the run worktree/branch.
  If recovery finds a reserved `creating` card, finalization first observes the
  provider branch and adopts a PR that already landed before drafting/creating;
  this makes retry converge on one card and one PR rather than duplicating
  either.

### Storage

Cards live in the `pull_request_cards` table (migration 0063,
`db/pullRequestCardStore.ts`), one row per card. `card_json` and `context_json`
hold the card and its server-only context exactly as the old JSON file did, and
they are the source of truth. The plain columns (`session_id`, `status`,
`worktree_id`, the two timestamps) are what reads select by, rewritten from the
card on every write. `seq` is insertion order, and "oldest first" means `seq`:
two cards created in the same millisecond keep the order they were stored in,
and the row summary's tie-break depends on it.

Every operation touches only the rows it names. The watcher's sweep reads the
`open` rows, a poll reads and writes its one card, and showing a session reads
that session's cards. A patch whose result is identical to the stored card and
context writes nothing and does not bump `updatedAt` — most watcher polls learn
nothing new. It still broadcasts the card, as before. The observation token a
poll mints is still a real write, one row per poll.

Three reads span the whole table, because their callers do:

- the session index's first build, once per process;
- the inventory's pull-request join, on every inventory refresh (the periodic
  5-minute one and each explicit one);
- boot's interrupted-action sweep.

None of them is on the watcher sweep, a poll, or the session-list rebuild. Each
is ONE statement, and the first two read only a few fields that SQLite extracts
from the JSON. `db/cardStoresQueryPlan.test.ts` shows that every other statement
searches an index. It also shows that a poll, a card update, showing a session,
a list build, delivery's worktree lookup and the workflow run list issue no
other statement.

Until 0063 the cards lived in `DATA_DIR/pull-request-cards.json`, rewritten
whole on every change. A one-time boot import moved them into these rows and
renamed the file to `pull-request-cards.json.imported-<ms>.bak`. That importer
is retired: every deployment had run it, and 0064 drops its
`legacy_file_imports` bookkeeping. The server neither reads nor deletes a
leftover `pull-request-cards.json` or its backup. A build older than 0063 is not
a rollback target.

### States

```
choosing-task → creating → open (CI · review · mergeable/conflicting · draft) → merged | closed
                    ↘ failed
```

`open` and `merged` also carry the card ACTIONS below.

- **choosing-task** — several linked Tasks qualify; the card lists them
  (`taskCandidates`) and waits for `resolvePullRequestCardTask` (pick one, or
  "none of these" to omit Task context). Reusing an EXISTING pull request never
  goes through this: it is adopted straight into whatever state it is already
  in.
- **creating** — drafting (the `prAgent.ts` agent) and the provider's create
  call are in flight.
- **open** — the PR exists and is being observed: `ci` (combined status),
  `review.changesRequested`, `mergeable`/`conflicts`, and `draft` are kept
  current by the watcher below. `mergeable` is three-valued and `null` means the
  provider cannot answer yet — never a conflict. `conflicts` is narrower still:
  it is a CONFIRMED conflict, claimed only once a second read of the same head
  reproduces `mergeable: false` (or a merge attempt was refused for it), because
  a single `false` is also what a queued conflict check answers.

  A review bot such as Percival fails its own check while its findings are open,
  so a team can make that check required. When EVERY failed check was posted by
  a GitHub App whose own review currently requests changes
  (`review.changesRequestedByApps`), `ci` leaves those failures out
  (`ciBesideReviewGates`), and the pull request reads as "Review", not "CI
  failed". One failure from anywhere else keeps `ci` red, and so does an app's
  failing check while its review does not request changes. The worktree hosting
  projection and the Pull Requests inventory apply the same rule. Check-watch
  tools still list every check, Percival's included.

- **merged** / **closed** — terminal; the watcher stops polling. A `merged` card
  still offers the local cleanup and the linked Task's answer.
- **failed** — drafting or creation raised; `error` holds the message. Reached
  only from `creating`. Deliberately a DEAD END for this stage: there is no
  retry or re-choose-Task action on the card itself, so recovery is re-running
  `/pr`, which mints a second card. A later stage may add one.

### The observer

`pullRequestWatcher.ts` adaptively polls every `open` card through the same
`gitHosting.ts` provider seam (`pullRequestDetail` + `ciStatus` +, while still
open, `pullRequestReview`): fast (~20s) while CI has not concluded, slow (~5
min) once it has and the card is merely awaiting review/merge, and never once
the card leaves `open` or crosses its hard lifetime cap. The one exception to
the slow cadence is a card a Workflow Run is parked on
(`workflowObservationArmedForCard`) whose mergeability is not yet `true`: that
run is blocked on an answer only the next poll can bring, and five minutes per
poll is the whole delay. A GitHub card has one cadence instead, five minutes
throughout — running CI and failed reads included — because each poll is four or
five requests out of the REST budget (5,000/hour) every agent tool shares;
Forgejo is local and keeps the adaptive one. It runs independently of any viewer
— a notification must fire whether or not a browser has the session open — and
is reconciled on boot (`reconcilePullRequestCardsOnBoot`, mirroring
`reconcileWorktreeMergesOnBoot`) so a conclusion missed during a restart is
still caught.

The poll also follows the pull request's base: a PR retargeted outside the
managed tool (provider UI, a generic edit) writes the reported base onto the
card and its context. The card is the record `worktree_finish_pull_request`'s
card check is compared against, so a card left on the old base would refuse a
merge the provider would accept. Because the stored base can move, a card merge
click carries the base the user SAW (`pullRequestCardAction.baseBranch`,
required for `merge`; a Workflow Run's merge carries its worktree's base), and
`mergeCard` refuses when the card no longer names it. The conflict confirmation
below counts consecutive reads of the same head AND base, and a conflict the
card stated about another base is not carried over: a retarget keeps the head,
and Forgejo's queued `false` on the new base would otherwise confirm a conflict
nothing checked.

The same read carries GitHub's native `stack`, written onto the card on every
poll so that a stack that merged down or dissolved clears. Cards are polled AT
ONCE, outside their cadence, in two cases: a merge the provider accepted but has
not confirmed (its own cards, whose real outcome this poll projects like any
external merge), and a confirmed merge whose head is the base of another open
card in the same repository — the provider retargets that pull request now, and
for a native stack rebases it. On GitHub's five-minute cadence that card would
otherwise state the old base for minutes.

A card OUTLIVES its checkout. Its `repoRoot` is the spawned worktree the pull
request was published from, and retiring that worktree is the ordinary end of a
delivery — after which the deleted path resolves no provider and is its own
`repoLockKey`, matching no other checkout of the repository.
`pullRequestHosting.ts` gives all three users of that path — the poller, the
card's merge action, and the repository identity cards are matched by — one
answer: the recorded checkout while it exists, the worktree's main checkout once
it does not. Every worktree of a repository shares one git directory, so the
main checkout carries the same remotes and the same lock identity. Without it a
retired worktree froze its card in `open` for good, and a Workflow Run parked on
that card's merge decision could be neither answered nor settled.

A CI conclusion (success/failure/error, never merely "pending") sends one Web
Push notification, deduped per (pull request, head SHA) pair so a rebase-heavy
branch gets exactly one notification per new head rather than one per poll.

Mergeability is the one field the watcher does not simply copy through. A
provider's `mergeable: false` is written to the card as `mergeable` verbatim,
but `conflicts` is set only when a SECOND consecutive read of the same head says
so — the count lives in the watcher's memory, and a conflict the card already
states counts as that earlier read so a restart does not un-say it and repeat it
one poll later. The reason is that `false` carries two answers on Forgejo: a
real conflict, and a conflict check that is merely queued. Latching the second
as the first paused a Workflow Run on a base conflict that never existed (Task
535).

That rule belongs to the FIELD, not to the watcher, so the merge projection
follows it too (`pullRequestMerge.ts`): the workflow merge's preflight asks a
conflicting read again, and says the base moved only when BOTH answers reported
`false` about the SAME head. The two reads are kept apart deliberately — a retry
that failed, answered nothing, or describes another head confirms nothing, and
reusing the first answer there would make an unreachable provider the evidence
for a rebase. Everything unconfirmed goes to the provider instead, whose own
refusal — re-fetched and classified — is the evidence a single read is not. A
projection that cannot confirm a conflict leaves `conflicts` alone rather than
writing one (`mergeable: true` is what clears it), because the card's answer is
the one an armed Workflow Run consumes as terminal.

That classification is bound to the HEAD the refused merge was conditioned on.
Every merge now carries an atomic head precondition, so one thing a refusal
routinely means is "that head is no longer the head" — and the follow-up read
then describes the NEW one, which Forgejo reports as not mergeable while it
recomputes. Blaming the base for that would tell the user to rebase and hand an
armed run a terminal conflict, when the branch simply moved under the merge. So
a conflict is confirmed only while the follow-up still describes the refused
head; a head that moved (or one this seam never knew, because the provider
derived the precondition from a read of its own) projects as an ordinary
moved-head observation and leaves the provider's refusal standing as the
outcome.

### Agent-facing check watches

The deferred, read-only `github_watch_pull_request_checks` and
`forgejo_watch_pull_request_checks` tools expose the same point-in-time/wait
contract for automation outside a Workflow Run. Each takes a repository and PR
number. With `wait: false` (the default) it returns one snapshot; with
`wait: true` it polls the PR's current head until at least one check appears and
every observed check is terminal, the PR closes/merges, or its bounded timeout
expires. A head that still shows no check at all two minutes after the wait
first saw it bare stops the wait with `no_checks` and state `none` — CI
registers its checks within seconds of a push, so waiting out the full timeout
on a repository without CI only spent requests. A push restarts that window, and
`none` still never reads as green. The default timeout is 30 minutes and callers
may raise it to two hours. Timeout is a normal result with the latest snapshot,
not a thrown loss of evidence. A wait polls every 15 seconds on Forgejo and
every 60 (at least 30) on GitHub, whose REST budget is shared; a GitHub wait
also stops with `rate_limited` once the provider's optional `rateLimit()`
reports fewer than 500 requests left in the window, and reports the remainder as
`observation.rateLimitRemaining`. Cancellation still aborts both the sleep and
in-flight provider request, and waits stream progress.

Every result identifies the exact head SHA, distinguishes the aggregate check
verdict from whether ALL checks have finished, and includes bounded provider
failure output plus web/log API URLs where available. GitHub Actions failures
carry the job id and ready-to-call `github_get_actions_job_log` arguments as the
agent-usable handoff (plus the authenticated API URL); Forgejo has no
token-authenticated log API, so its status target/run web URL is the log
handoff. A truncated provider page stops a wait immediately with
`checks_truncated`: unseen checks prevent green, but an observed failure remains
red. `canMergeNow` is a conservative preflight requiring an open, non-draft PR,
provider `mergeable: true`, terminal non-failing checks (no checks remains
visibly `none`), and no hosted changes-requested review. Its blockers are
returned explicitly. It is not a dry-run merge: provider permissions and branch
rules remain authoritative when a later merge is attempted.

#### Ref check waits

`github_get_ref_checks` and `forgejo_get_ref_checks` keep their compact, single
snapshot by default. `wait: true` follows a branch, tag or commit using the same
poll loop and bounds: timeout defaults to 1800 seconds, range 30–7200; intervals
default to 60 seconds on GitHub and 15 on Forgejo, minimum 30 and 5
respectively, maximum 120. Stop reasons are `checks_finished`,
`checks_truncated`, `no_checks`, `timeout`, and GitHub's `rate_limited`. There
is no PR-open-state stop. A new head restarts the 120-second no-checks grace.
Wait results add `finished` and `observation`, including mode, stop reason, poll
count, elapsed time, effective timeout, interval and resolved `headSha`, plus
GitHub's remaining rate budget when reported. The top-level `state` stays the
raw provider value, including `neutral` for an empty ref; the internal verdict
`none` is not substituted. Forgejo's opt-in history is read once at the end.
`background: true` uses the same background-watch lifecycle below and the same
compact final payload as a foreground wait, apart from its observation mode.

#### Background watches

Managed finishing also offers [merge when ready](#merge-when-ready), which uses
this background backend but keeps all managed merge authority checks.

`background: true` turns the wait into PA background work instead of blocking
the agent's turn for up to two hours, which is what led agents to start whole
watcher sessions just to wait for CI. It implies `wait` on both PR and ref
tools.

- **One observation in the call.** The tool polls once in the call itself. If
  that already ends the wait (checks finished, the PR is not open, the page is
  truncated, the rate limit is low), it returns that result inline, with
  `observation.mode: "background"` and no task id, and starts nothing. Otherwise
  it admits a `check-watch` item on the `server-task` backend
  (`app/server/src/serverTasks.ts`) and returns
  `{ taskId, state: "running", hint }` at once. No progress is streamed.
- **Owned like any background work.** The item shows in the Background tasks
  view as a "Check watch" run by "PA server". The owner stops it with
  `background_tasks` (`stop`, `stop_all`), and a human with Stop. Ending or
  stopping the turn that started it does not stop it: the job resolves its own
  provider client, bound to its own abort signal. Only an interactive top-level
  user session may start one, and a refusal throws `Background work denied: …`.
- **Frozen budget.** Admission asks for a lifetime of `timeoutSeconds` plus one
  minute, capped by Settings → Background processes (default 60 minutes). The
  job's effective timeout is that lifetime minus the minute,
  `min(timeoutSeconds, lifetime − 1 min)`. The watch therefore ends with its
  normal `timeout` result, reporting the effective `timeoutSeconds`, before its
  deadline Stop. The Stop only ends a job whose last provider call overran. Its
  clock runs from before the call's own poll, so admission never restarts it: a
  30-second watch with a 120-second interval polls twice and times out at 30
  seconds.
- **Delivery.** The final result, the same JSON a `wait: true` call returns
  except for `observation.mode`, is the item's JSON artifact (its output file),
  and its terminal fact reaches the owner through the unchanged completion
  delivery: it wakes an idle session, steers into a running pi turn, and waits
  for a running Claude turn to end, then wakes it. The row's one-line summary
  names the stop reason, the verdict and the short head SHA.
- **Restart.** A watch runs inside PA's server process and is never resumed.
  When it ends during a deployment drain (naturally in the grace, by any Stop,
  or by the drain's own Stop), or boot reconciliation ends it after a crash, its
  owner is still woken after the restart (`steering-and-queueing.md`,
  "Background facts survive a restart"). A watch the restart ended says so in
  its summary; one that finished in the grace keeps its real result.

### The indicator on session rows

A card is durable state of ONE session's transcript, so until you open that
session nothing says which of your sessions is the one waiting on a review. Each
session's list row therefore carries the card's state as
`SessionListItem.pullRequest` (`SessionPullRequestSummary`): the card's status
plus its number, CI, review, conflict and draft flags — never its body, its
warnings or its linked Task, which are the card's to render.

A session with SEVERAL cards is stated by ONE: the newest card that is still
moving (`choosing-task` / `creating` / `open`), else the newest terminal one. A
row is one line, and ranking several cards on it would say less than the one
that is still going. `pullRequestCards.ts` owns that choice
(`pullRequestSummariesBySession`). It is memoized because the session list is
rebuilt up to ~4 times a second: each write marks its session stale, and the
next build re-reads only those sessions' rows. A card create/patch asks for a
session-list broadcast as well as the card update — CI turning red moves nothing
else about the session — but only when the session's ROW would say something
different, since the watcher patches an open card on every poll whether or not
the provider said anything new. What a row says about this store is TWO answers,
not one: the summary card AND the Task-pick block below, because the second is
not a function of the first.

### The indicator on worktree rows

A checkout carries the same answer. `WorktreeRecord.pullRequest` is the card
that speaks for that worktree, chosen by the session row's rule over every card
whose `worktreeId` names it — whichever session made the card, because a peer's
`/pr` and its coordinator's `worktree_create_pull_request` on one checkout are
one delivery (`pullRequestSummaryForWorktree`, over the worktree index). Every
worktree row draws it with `SessionDeliveryMark` as a glyph, which is what lets
a coordinator's inspector, the Project page and the Projects browser state its
peers' pull requests without opening a session. A card write that changes that
answer — not the watcher's every-poll patch — rebuilds the worktree list, the
same gate as the session list's. A pull request opened without a card (a generic
provider tool, or by hand) is not stated here; the hosting projection and the
Pull Requests view still see it.

### A Task pick is human-blocking work

A `choosing-task` card is not merely a state to render: the `/pr` command
drafted nothing and is WAITING for you, exactly like a pending approval. It
therefore drives the session attention indicator on the same seam as approvals
(Task 327): `pullRequestCards.ts` answers `choosingTaskSessionIds` /
`hasChoosingTaskCard` with one indexed query over the `choosing-task` rows, and
`subscribeChoosingTaskCardChanges` tells a live harness when that answer moves
under it (fired only when the session's answer actually CHANGES, so the
watcher's routine patches cost nothing). Both harnesses fold it into `state()`'s
`idleReason` (`awaiting_task_choice`) after the pending-question and
pending-approval checks, and the session list reads the set once per build
alongside `pendingApprovalSessionIds`.

The row states it as `attention: "task-choice"` with `awaitingInput` — its own
kind rather than a `question`, because the answer is a click on that card, not a
reply in the composer. The Sessions inbox therefore lifts it into **Needs you**
with a "Pick task" badge, `settleBlockedReason` refuses to settle it ("it is
waiting for you to pick a Task."), and the one-line rows word their existing
blocking glyph by the kind.

An unanswered prompt counts here even when a newer `/pr` run has taken over the
session's ROW: the summary answers "what does this row say", while attention
answers "is a human still being asked something". That is also why the
session-list broadcast gate above compares the Task-pick answer alongside the
summary — answering an older `choosing-task` card while a newer `open` card
holds the row moves the badge without moving the summary, and a pi or idle
session has no live subscription that would rebuild the list for it.

The browser ranks the summary in `lib/sessionDelivery.ts`, on the SAME ladder as
a Backlog row (`lib/worktreeHosting.ts`'s `hostingAttention`), with the rungs
only a card has around it: `choosing-task` and `creating` before the pull
request exists, `failed` for a card that never opened one, `conflicts` directly
under red checks, and `draft` on the rung a plain open pull request would take.
A TERMINAL card is its status and nothing else: the watcher stops polling once a
card leaves `open`, so its last CI reading is frozen, and ranking a red check
above the merge (as the ladder does for a worktree, whose CI is live and
self-corrects) left a shipped pull request reading "CI failed" with nothing able
to revise it.

`SessionDeliveryMark` renders it at two widths — a worded chip on the Sessions
inbox's cards, after the state line's own text so the failure message keeps that
line's width; the glyph alone on the one-line rows (the shelves, and the
sessions nested under a Project or Worktree). The glyph is per STATE, not a tint
per state: colour alone would state nothing to a reader who cannot separate the
tones, so merged, closed, draft, conflicted and failed-checks each have their
own shape and the tone rides on top. It is deliberately not a link: the card
lives in the session, so the ROW is what opens it, and the state is named in
each row's `aria-label` because those rows are single buttons whose label
replaces their content.

### Card actions

A live card is also where the pull request is ACTED on. Every action is
user-initiated, runs through `pullRequestActions.ts` over one validated
`pullRequestCardAction` message, and is serialized on the card's durable
`busyAction` — a second click, from this tab or another, is refused rather than
racing the first. A failure leaves the card's state alone and shows
`actionError` next to the button that caused it. Because `busyAction` is
durable, `reconcilePullRequestCardActionsOnBoot` clears one left behind by a
restart or crash and records that the action was INTERRUPTED (it may or may not
have landed) rather than silently forgetting it — otherwise the card would
refuse every later click forever.

The browser's [mutation lifecycle](state-sync.md#client-mutation-lifecycle)
releases its local pending claim and embedded Task optimism silently on genuine
connection loss. This does not clear durable busy or cancel server work.
Reconnect reads determine what landed, with action-specific recovery after
subscription send and no automatic retry. Mounted merge-method and branch-delete
choices remain current. Connected completion, the durable gate, and the
start-based 30-second linked-Task / 15-minute remote-action deadlines are
unchanged.

The two local actions also refuse a card whose `baseBranch` is not the
worktree's: `/pr --base <branch>` can target a base the checkout does not track,
and rebasing onto (or verifying containment against) the worktree's base while
reporting the card's would be a claim about a branch nobody touched.

Every mutation of one pull request is serialized across BOTH surfaces by
`withPullRequestMutation`, keyed on repository identity + provider + number. It
holds two keys: the checkout's lock key and, when the provider's URL proves a
repository, the hosted `<provider>#<owner>/<repo>#<number>` key
(`pullRequestIdentity.ts`). The approval-gated generic edit tools have no
checkout and take only the hosted key (`withHostedPullRequestMutation`), so an
approved retarget is refused while a managed merge, close or retarget of the
same pull request runs, and cannot land between that merge's identity read and
the merge. `busyAction` locks a single card, which is not the same thing: the
worktree page has no card at all, and a second card can exist for the same pull
request. The loser is refused before any provider or git side effect, never
queued — waiting would run it against a repository the winner has since changed.
That is what stops a card's `update-with-main` from force-pushing a rebase onto
a branch another surface just merged and deleted.

- **Merge** (`open` only) — the method (squash / merge / rebase) is chosen on
  the card, per merge, and so is the fate of the remote head branch: a **Delete
  remote branch** checkbox, CHECKED by default, next to the merge button, with
  the sentence under it stating which of the two this click will do before it is
  clicked. Both travel with the click (`pullRequestCardAction.mergeMethod` /
  `deleteBranch`, and `WorktreeMergePrRequest` for the HTTP surface) rather than
  living on the card, and only the opt-out is sent: an omitted `deleteBranch`
  deletes, as it always did, so an older client merges unchanged.
  `gitHosting.mergePullRequest` merges AND deletes the remote head branch as one
  call, so no caller orchestrates two steps. GitHub takes
  `PUT /pulls/{n}/merge-async` with the exact-head `sha`,
  `merge_action: "direct_merge"` (the default action ENQUEUES on a base with a
  merge queue, which is not "merge now") and never `bypass_rules`, and then
  polls `GET /pulls/{n}/merge-async/{uuid}` under the pull request's mutation
  lock, backing off from 1 s to 5 s within an ABSOLUTE 45 s budget: the PUT,
  every wait and every poll's own request time count against it, each wait and
  each request's timeout is cut to what is left, so slow answers cannot hold the
  lock for a dozen request timeouts. A 409 names the request already running for
  this pull request and is followed — making a retry after a lost answer
  idempotent — but only when its `expected_head_sha`, `merge_method` and
  `merge_action` are this merge's; someone else's request is refused. Every
  refusal body is JSON with `status` and `details.message`, which is what the
  user reads: a stale `sha` (400 "head branch was modified") reads as the
  ordinary moved-head refusal, and a request whose poll ends `failed` (a draft
  below the target is accepted and fails there) throws with its message. Only
  `status` decides, never the message: the accepting 202 says "enqueued" even
  for a direct merge. A request that is still running when the wait ends, is
  `enqueued`, or whose status cannot be read is `outcome: "pending"` — never a
  merge and never a refusal. Forgejo takes one `POST /pulls/{n}/merge` with
  `Do`. Only after a CONFIRMED merge is the head branch deleted, and only while
  no OPEN pull request targets it as its base (GitHub: one
  `GET /pulls?state=open&base=<head>` page; Forgejo cannot filter by base and
  pages its open set): the merged branch is the base of whatever is stacked on
  it. On a native stack GitHub has already retargeted that pull request when the
  poll reports `merged`, but on a plain chain (a Pandeck-managed stack) it does
  not retarget at all: deleting the merged head CLOSES the child at once, for
  good (seen live). A dependent, or a dependents read that failed, keeps the
  branch with `branchKeptReason`, and the outcome sentence says why. GitHub then
  takes `DELETE /git/refs/heads/<branch>`; Forgejo takes
  `DELETE /branches/<branch>` and CONFIRMS it with a branch read where ONLY a
  404 counts as gone (any other answer, including one that could not be
  obtained, is reported as unconfirmed rather than invented), since a protected
  head branch survives the same answer. Forgejo used to delete inside the merge
  request (`delete_branch_after_merge`), but only blindly; the guard needs the
  merge first, and a read before the merge would sit in the identity window. A
  PENDING merge projects none of what follows a merge: no terminal card state,
  Task suggestion, Workflow record, base refresh or branch deletion. Its cards
  keep `open`, get the outcome sentence as `actionMessage`, and record the
  request in their server-side context (`pendingMerge`: request id, conditioned
  head, time, that message); the same record is kept by pull-request identity in
  `pendingMerges.ts`, for a surface with no card. The watcher then follows it on
  the fast cadence, asking `mergeRequestStatus` BEFORE the detail read so the
  detail already reflects a request that just finished, and judges it with
  `judgePendingMerge` — the one judgement the Pull Requests view's check uses
  too:
  - the pull request merged or closed settles it (a merge runs the ordinary
    merged observation);
  - a FRESH provider answer always wins, however old the request: `failed`
    leaves the card open with the provider's reason as `actionError` and Merge
    on offer again, `pending` keeps it, and `expired` — GitHub forgets a result
    24 h after its LAST update — leaves the pull request's own state to speak;
  - without one (the provider named no request, or its status cannot be read),
    only the pull request can answer: a head that moved past the conditioned one
    means that merge cannot land (reported as a failure), and a watch that runs
    out — ten minutes with no request id, or a day since reading its status
    STARTED failing (`unreadableSince`, cleared by any fresh answer; never the
    request's age) — ends with the card saying plainly that whether it landed is
    unknown, never "did not merge";
  - an `unknown` ending is itself kept, as a tombstone on the record
    (`unknownReason`), on the card and by identity: every later poll and check
    keeps answering "unknown" until the pull request goes terminal, its head
    moves past the conditioned one, a fresh "still running" brings the request
    back to life, or a new attempt replaces the record. The server knows it sent
    that merge, and absent evidence never becomes "did not merge".

  Whatever settles it clears the pending message (only that message), and a
  confirmed merge from any surface clears the record. The PR view reports a
  pending merge as an unknown outcome (see [Merge & clean up](#merge--clean-up))
  and the worktree page as unconfirmed. The provider decides whether a merge is
  allowed — branch protection, required checks, stale mergeability — and its
  refusal surfaces as the card's error rather than being pre-judged here. A
  branch deletion that fails afterwards is reported but never turns a landed
  merge into a failure, and the outcome sentence says what happened to the
  branch rather than what was asked for — kept on purpose, deleted, or not
  deleted with the provider's reason. The ONE thing the card decides itself is a
  known conflict: while `conflicts` is set the merge button, its method picker
  and the branch checkbox are all disabled, the update below becomes the card's
  primary button, and the reason is written out as text under the row (a tooltip
  on a disabled button reaches neither a keyboard nor a phone) in place of the
  branch-outcome sentence, which would otherwise describe a click that cannot
  happen. `mergeable: null` is not that state — it is still being computed, and
  merge stays on offer.

- **Update with main** (`open`, worktree sessions) — the deterministic path
  first: `pull-rebase` on the project's main checkout, then `rebase-main` on the
  worktree, then a lease-guarded force push so the pull request actually sees
  the rebase. Only a genuine CONFLICT (`WorktreeSyncConflictError`, raised after
  `worktreeSync` aborted the rebase and restored the branch) hands the work to
  the session's agent through `promptRuntimeSession`, steering when it is
  running. A dirty or diverged main checkout is reported as itself, never
  dressed up as a conflict.

  A handoff moves the work OFF the card, which the card has to say: the action
  is finished (`busyAction` cleared, the watcher polling again) while the rebase
  has only just started somewhere else. `recordRebaseHandoff` therefore writes
  `rebaseHandedOff` alongside its outcome sentence — set only on the accepted
  path, so a prompt that never landed leaves the click to be made again — and
  the button then reads "Agent is rebasing", busy and disabled, with the
  conflict note pointing at the session instead of at itself. It is the LAST
  action's fact only: the next action clears it, and so does a watcher poll that
  sees the branch republished, because the branch moving is what ends the
  handoff. "Republished" is measured against the head the agent INHERITED,
  recorded as `rebaseHandoffHeadSha` by the action itself (before the prompt is
  offered, so a poll landing in between already knows it): the card's last
  provider observation where there is one, else the local branch head, which the
  aborted rebase has just restored. Comparing against "whatever was observed
  last" is the bug this avoids — a card whose FIRST poll only lands after the
  agent's force-push would adopt the rebased head as its own baseline and never
  recognise the push. A handoff with no baseline at all (nothing observed, no
  local read) is ended by the first observation after it, since that poll cannot
  tell the two heads apart and the button is better handed back than disabled on
  a guess. That absence is a state of its own and is written as such: the
  baseline belongs to ONE handoff, so every action clears it on the way in and
  writes its own answer on the way out. A later attempt must never inherit an
  earlier baseline — the branch can have moved out of band in between, and the
  watcher would read that stale SHA as this rebase having been published. The
  renderer pairs it with the session actually streaming, so an agent that gave
  up — or a flag that outlived its turn — hands the button back rather than
  leaving the card a dead end. The browser that CLICKED also follows the prompt:
  `App.tsx` remembers the intent per card and pins the transcript to the bottom
  when that card's handoff arrives, not at click time (there is nothing to
  follow yet, and the rebase may still resolve deterministically) and not in
  another viewer of the same session, which never asked for anything.

- **Clean up worktree** (`merged`, worktree sessions, settleable sessions) — the
  local counterpart of a remote merge, never automatic, with its consequence
  stated on the button. It and the Worktrees-inbox **Retire** action share
  `worktreeRemoval.ts`'s `retireWorktree` sequence: fetch the exact remote base
  target (or use the local ref for a local-only repository) →
  `branchContainedInBase` against that immutable commit → removal hold →
  `removeWorktree({ deleteBranch: true, branchContainmentBase })` → settle the
  sessions. The exact target is carried into the removal's own containment
  guards, so a stacked workflow does not depend on its local epic-base worktree
  having pulled the provider merge already. The seam returns structured
  branch-deletion and session-count facts so the `/pr` card and inbox write
  surface-appropriate outcome text without owning a second lifecycle
  implementation. `/pr` cleanup never passes `force`, so a branch the refreshed
  base does not contain stops that surface with an explanation; inbox Retire
  accepts it only after explicit lost-work consent. Containment is asked only of
  a retirement that DELETES the branch: keeping it keeps every commit on its
  ref, so a checkout-only retirement has nothing to verify, nothing to consent
  to and no reason to refuse — the refreshed target is still carried into
  removal for the guards that do apply. A base that cannot be refreshed at all
  (deleted, renamed upstream, never local) is DATA in the same way: it proves
  nothing either way, so it refuses only the unconsented branch deletion, naming
  the missing base and the two answers that work; keeping the branch or forcing
  proceeds with no containment target at all, since a thrown rebase error there
  left such a worktree unretirable by every answer the dialog can give.

  Every refusal carries `refusalKind`, because a refusal about UNCERTAIN
  DELIVERY is the only thing a surface may escalate to `force` from. Retirement
  verifies by fetching the base and comparing against that exact commit, and no
  local scan substitutes for it: a base branch absent locally may still be on
  the remote, so pre-empting that check with consent would discard commits the
  verification was about to clear. So the inbox remembers a `"delivery"` or
  `"git-guard"` refusal for that worktree and the dialog quotes it above the
  consent, while a `"sessions"` refusal is dropped — `force` never overrides
  those gates, and offering it there would be a checkbox that changes nothing.
  `"permissions"` is dropped for the same reason and means something new: the
  checkout holds a directory owned by ANOTHER uid, typically written by a
  container that bind-mounted it and ran as root. Removal already tried to
  reclaim it through the container runtime (`docs/container-images.md`), so what
  reaches the user is the case that could not be repaired, quoted with the
  `sudo` that fixes it. No consent this app can offer makes another user's files
  deletable. Losing LOCAL work is a different question and keeps its pre-emptive
  consent (a dirty tree, or a branch this browser can see is ahead): those are
  facts the surface already holds, stated in the dialog before the click.

  What the run actually did is likewise the server's to report, not the
  surface's to assume. `force`, keeping the branch, and a pending branch-cleanup
  retry (whose oid-bound deletion also succeeds on an already-absent branch,
  proving nothing) all skip or fail to establish containment, so a retirement
  answers with `deliveryVerified` and the inbox writes the outcome that matches:
  verified deletion; deletion WITHOUT verification, which only a forced one may
  say, since force IS the decision to skip the check; deletion without a
  confirmed check, for an unforced one that established nothing; or a
  checkout-only retirement that kept the branch and claims no delivery either
  way. `deliveryVerified: false` is never the opposite claim — it says this run
  did not prove delivery, not that the branch was undelivered. Since the flow
  ENDS by settling sessions, it answers to the shared `settleBlockedReason`
  predicate, not merely "is it running" — a queued prompt or a pending
  approval/question blocks it in the same words the browser and
  `connection.onSettleSession` use. Sampling that predicate is not enough on its
  own, however late it is sampled: another connection can start a run in the gap
  between the sample and the removal, pass its own worktree guard while the
  checkout still exists, and be left running in a deleted tree. So cleanup takes
  a HOLD on the session first (`session/sessionRunLease.ts`) and only then makes
  its final settleability check, the removal and the settle. While the hold is
  in place `runtimePrompt.ts` — the one app-level prompt facade every path is
  contractually required to use — refuses to start a run, before anything is
  appended; while a run is in flight the hold cannot be taken and cleanup
  refuses instead. Both sides are synchronous check-then-set, so they cannot
  interleave. The held resource is the WORKTREE, not a snapshot of its sessions:
  every prompt resolves its session's CURRENT worktree at admission, so a
  session forked or handed off onto that checkout AFTER the hold was taken is
  refused by the same hold — a list captured beforehand could never contain it.

  A shared worktree is a CONSEQUENCE to state, not a reason to refuse. One
  checkout normally carries a dev session plus the review and fork sessions spun
  off it, so cleanup settles every session still LIVE on it —
  `liveSessionIdsForWorktree`, which skips the settled, archived and deleted
  ones, because the `in_worktree` edges are insert-only and a finished review
  session must not stand between a merged pull request and its worktree. The
  button says what that means before the click ("settle this session and N
  others on this worktree") and the outcome repeats it. Each of those sessions
  answers the same `settleBlockedReason` predicate, so a sibling that is running
  — or holds a queued prompt or a pending approval — refuses the whole action
  instead of being settled while it is not done. The list is taken again under
  the hold, so a session linked while the base was being fetched is included or
  refuses, never settled unasked.

  The worktree inspector's own Remove is the removal-only variant of the same
  act (it deliberately does not pull or verify main), so it answers the session
  safety part identically (`worktreeRemoval.ts`, called by
  `connection.onRemoveWorktree`): the live sessions on the worktree must pass
  `settleBlockedReason` before any git side effect, the worktree hold is taken
  for the removal, the predicate is asked again under it, and the sessions are
  settled afterwards through the shared `settleSessionsForRemovedWorktree`
  (`sessionActivity.ts`). Live sessions leave the inbox; every linked session —
  the finished ones included — is refreshed so a session viewing the dead
  checkout raises its Task-321 banner immediately. `force` there overrides
  losing GIT work (a dirty tree, unmerged commits it is about to delete) and
  never the session gates: it is not a licence to delete a directory an agent is
  running in. The Remove dialog states that consequence where the button is, and
  it asks for force on exactly what the configured removal would lose — no more
  and no less: uncommitted changes always, unmerged commits only when the branch
  goes too, and containment THIS SURFACE cannot verify. A base branch that
  resolves to no local commit (deleted, renamed, never pulled) reports
  `baseUnresolved`, because counting `ahead` against a missing ref yields 0 and
  used to be read as delivered — hiding the decision on the very surface whose
  removal was about to be refused for it. It is a LOCAL fact and says nothing
  about the remote, which is exactly why it settles the question only for
  inspector Remove: that flow never fetches, so the missing ref is its final
  answer and its guard will refuse without consent. Retire is the opposite — see
  its escalation rule above; consent there answers its refusal, never this
  field. Force covers every risk at once, so the dialog states all of them
  rather than letting a dirty tree speak for an unverifiable branch.

- **Mark Task done** (`merged`, linked Task; refused before that) — a merge
  writes a `done` status SUGGESTION on the linked Task with the reason
  `PR #N merged`, from the card action and from the watcher alike (merging on
  the provider's web UI is the same event). This button is the ANSWER to that
  suggestion, so it writes the status directly as the user.

The same merge is exposed over HTTP as `POST /api/worktrees/:id/merge-pr`, which
the worktree page's Delivery section uses, and as
`POST /api/pull-requests/merge`, which the Pull Requests view's Merge & clean up
uses (see "Merge & clean up" below — it is the only one of the three that also
performs the LOCAL cleanup in the same call, and the only one whose caller holds
the mutation lock across both halves). Every surface goes through ONE
projection, `pullRequestMerge.ts`, which is what keeps them from drifting:
sharing only the provider call was not enough, because each surface then updated
only its own store — a merge in chat left the worktree page offering Merge from
its cached open PR, and a merge on the worktree page left the card open until
the watcher's slow poll. The projection merges once and then writes every place
the pull request is shown: each matching live card → `merged`, the linked Task's
`done` suggestion, and the worktree hosting cache. Cards are matched by
REPOSITORY IDENTITY (`repoLockKey`, the common git dir shared by a repo's main
checkout and all its worktrees) plus provider and number, never by checkout path
— the two surfaces name the same pull request from different paths.

After a provider accepts a merge initiated by PA, that projection also performs
one TARGETED local base refresh for the managed project; it never sweeps every
project or checkout. It fetches the exact remote base oid (also refreshing the
remote-tracking ref when the source is a configured remote name), then either
fast-forwards the clean managed checkout that holds the base and updates its
submodules, or fast-forwards an existing local base ref that is checked out
nowhere. Every no-write case is named in the outcome sentence rather than
silently skipped: a dirty, detached or diverged checkout, a base that is already
current, a base with no local ref (refresh is not create), and a base with no
configured remote; Git's refusal when an unmanaged worktree holds the ref is
data too. Only the base checkout and merged worktree status caches are
invalidated. A refresh failure is logged but cannot turn an already accepted
provider merge into a failure. The local cleanup still stays with the card,
where the state that justifies it is visible.

### `pullRequestDetail`

Each `gitHosting.ts` provider additionally answers point-in-time PR detail —
state, merged, mergeable, draft, head SHA, base branch. `mergeable` is
THREE-valued for both providers and `null` means "ask again," never
"conflicting" — but the providers reach it differently. GitHub computes it
asynchronously and answers `null` itself immediately after a push while it
recomputes. Forgejo has no unknown value at all: it answers `false` for a real
conflict, for a queued conflict check, AND for every draft/WIP pull request
whatever its base looks like. The provider therefore maps a draft's `false` onto
`null` (a draft says nothing about mergeability), and a non-draft `false` is
still only a candidate conflict until the watcher's second read confirms it.

## The Pull Requests inventory

`GET /api/pull-requests` (`pullRequestHttp.ts` → `pullRequestInventory.ts`)
answers the Pull Requests view with one `PullRequestInventoryResponse`: the pull
requests that still want something from the user, each already joined to the
local objects the client cannot join itself.

Selection has two halves, and they come from different reads:

- An OPEN pull request is inventoried when it is YOURS, when you are ASSIGNED,
  or when a review was requested of you or of a TEAM you are in. It comes from
  the per-project open-PR list (`projectPullRequests`, 60 s cache) that the
  Project page already fills. Everything else open on the repository belongs to
  that page, not to this view. A draft is listed and flagged, never hidden. Each
  item says which of these hold (`mine`, `reviewRequested`, `assignedToMe`,
  `teamReviewRequests`), because the view states every reason, not only the
  strongest.
- Team membership is one REST read per provider token (GitHub `/user/teams`,
  Forgejo `/user/teams`), cached 15 minutes and shared by every repository. It
  is REST because GitHub's GraphQL `Team.organization` needs the `read:org`
  scope, and one unreadable field fails the whole list query; the list reads
  only each team's `slug`/`combinedSlug` and matches those against the
  membership. Unknown membership leaves `teamReviewRequests` ABSENT, never
  empty.
- A MERGED or CLOSED pull request is inventoried while a local active worktree
  still holds its head branch. That is the cleanup queue: the checkout is the
  thing left to deal with, and this is what keeps a merged pull request visible
  until it is gone. It is derived from the per-worktree hosting projection
  (`worktreeHostingStatuses`, 15 s cache), which already reads a branch's latest
  pull request in whatever state — never from a second list call.

Those two caches are the only provider conversations the inventory shares with
the worktree surfaces, so an open worktree page and the background refresh
coalesce rather than doubling them. Mergeability, the exact head and that head's
CI live in neither, so they are read per LISTED pull request —
`pullRequestDetail`, `ciStatus` for the head it reported, and
`pullRequestReview` unless the worktree projection already answered it — with
bounded concurrency. On GitHub the open list is ONE GraphQL query that also
reads each pull request's mergeability, head, head CI and review, and those
annotations answer the inventory directly (`openPullRequestAnnotation`) for two
minutes or until any write through the provider drops them; the per-pull-request
reads remain for Forgejo and for a GitHub pull request whose listed commit was
not its head. Each of those reads has its OWN TTL cache (the sync period) with
in-flight coalescing, so overlapping refresh requests are one provider
conversation, and only an ANSWER is ever cached: a CI outage neither pins an
absent CI onto a pull request whose detail answered nor is retried before the
detail is. A provider `null` where the seam documents it as "could not be
determined" (detail, review) counts as a failed read; `ciStatus`'s `null` is the
real answer "this head has no checks" and is cached as one. Skipping the review
read because the worktree projection has one writes nothing, so a later build
without that projection still performs it.

The per-worktree projection batches too: every row of one GitHub repository is
answered by ONE GraphQL query (`branchStatuses`: the branch's pull request, the
local HEAD's check runs and commit statuses, and an open pull request's review),
all rows or none, instead of three or four REST reads per row. A one-minute REST
loop over about twenty worktrees spent roughly 4,000 requests an hour; both
queries cost two GraphQL points from the separate GraphQL budget.

Every REST GET through `githubRequest` is conditional after its first answer:
the client keeps a bounded ETag cache (per token, Accept and URL; 256 entries,
bodies up to 256 KiB) and sends `If-None-Match`, and GitHub does not charge a
`304 Not Modified` against the REST budget. A poll that re-reads an unchanged
pull request or check page — most of a check watch — therefore costs nothing.
The client also records each token's CORE REST budget from
`x-ratelimit-remaining`/`-reset` (`githubRateLimit`) — GraphQL and search
answers carry budgets of their own and are skipped — keeping the lowest
remainder per window, since parallel reads answer out of order. The GitHub
provider exposes it as `rateLimit()`.

`headRefName` matches same-named branches on every fork, so a full page that
holds fork pull requests cannot prove ours absent: that branch falls back to the
owner-filtered REST lookup. A GraphQL answer with any `errors` entry, without a
node list or without a branch page's `hasNextPage` fails the batch rather than
reading as "no pull request", and review requests beyond the first hundred are
settled by the REST list paged to its end (ten pages, then unknown). All generic
PR tools write through the provider seam. GitHub mutators evict annotations even
on failure and prevent a list read started before the write from restoring stale
annotations. The approved executor also calls `invalidateGithubPullRequestWrite`
to drop the list and that pull request's reads and rebuild the inventory.
Forgejo uses `invalidateForgejoPullRequestWrite`. Both tools do this after every
approved operation, even a partial failure, except standalone timeline comments
and review replies. Closing with a comment is still one inventory-invalidating
operation.

`pullRequestInventorySync.ts` builds this projection once at server startup and
five minutes after each completed build, independent of whether the Pull
Requests view is open; an action on a pull request still refreshes it within two
seconds. Refresh requests inside that window coalesce onto one build (a batch
worktree cleanup invalidates once per removal), and concurrent hints coalesce
onto an in-flight build. A build has a 90-second deadline; one that misses it is
abandoned but keeps running, so the next build waits for it to settle (at most
one more deadline) instead of running beside it. Repeated whole-build failures
back off to fifteen and then thirty minutes. A completed partial build keeps the
normal cadence so one failed project cannot slow healthy ones. The production
service is the single timer owner (`ASSISTANT_BACKGROUND_PR_SYNC=1`); previews
cannot multiply provider traffic, while the ordinary development server enables
the loop by default.

A completed build is merged per project into the versioned, private cache file
`DATA_DIR/cache/pull-requests/inventory.json`, written by tmp+rename. This is
derived provider state rather than durable user-authored data, so a corrupt or
old-version file is a cold cache. A project whose provider read failed retains
its older items and timestamp; a successful empty answer removes them. Projects
with no registered worktrees are swept. A mutation bumps the snapshot epoch, so
a build that started before it cannot overwrite the newer state and runs again.
Removing a worktree — every path: the panel's Remove, an agent's
`worktree_remove`, a retirement, a run's cleanup — calls
`forgetWorktreeInPullRequestInventory` once the removal succeeded
(`worktreeRemoval.ts`). It rewrites the snapshot at once, with no provider read:
a merged or closed item listed for that checkout is dropped, an open one loses
its `worktreeId`. It then bumps the epoch and requests a rebuild, so a build
that started before the removal cannot write the checkout back. Without this a
cleaned-up pull request stayed in Needs cleanup until the next five-minute
build.

`GET /api/pull-requests` reads only this local snapshot. With a cold cache it
answers `status: "cold"`; the client keeps the surface in its loading state
until one provider-backed build lands rather than rendering an error or claiming
the inventory is empty.

Every key in this projection is a REPOSITORY and a number, never a number alone
(`pullRequestIdentity.ts`: `<provider>#<owner>/<repo>#<number>`, derived from
any repository or pull-request URL the provider gave us). Two repositories both
having #7 is the ordinary case, and one project can hold two of them, since a
spawned worktree may publish to a `pushurl` repository its main checkout does
not list. A number-keyed join would hand one repository's sessions, Tasks,
authorship or review state to another's pull request. The host is deliberately
not part of that identity: one provider kind is one configured instance here, so
`owner/repo` already separates repositories, while the same repository's links
legitimately arrive under different roots (a Forgejo `ROOT_URL` that differs
from the configured base URL) — keying on the host would split one repository in
two. A URL that proves no repository yields no key, and its holder contributes
nothing rather than joining on the number.

The 15 s read wins a disagreement about the SAME pull request: one the list
still calls open while that repository's branch projection reports it merged or
closed is inventoried as terminal, and only its own list entry (matched by
identity) can still state authorship — a pull request that has left the list
reports `mine: false` rather than guessing from the surviving branch. A terminal
item deliberately carries no CI, review, mergeability or capabilities: there is
nothing left to merge or review, and the local head's CI is not the pull
request's.

The local joins are IDS only, because the web already holds worktree records,
session rows and Backlog Tasks. `worktreeId` is the worktree that PUBLISHED this
pull request when the hosting projection found it there, else the project's
active worktree standing on the head branch — but never one whose own projection
found a different pull request, because a same-named branch publishing elsewhere
is other work. `sessionIds` are that worktree's linked sessions plus the
sessions whose `/pr` card carries the same pull-request identity
(`pullRequestCardLinksByPullRequest`), and `taskIds` are those cards' linked
Tasks plus the worktree's Task edges. Both are de-duplicated, worktree edges
first.

Absence means UNKNOWN throughout, as in the hosting projections. Inside one
provider build, an unreachable project contributes nothing rather than an empty
slice; the persisted merge then keeps that project's last answer. A failed CI or
review read leaves its field absent instead of inventing a clean answer, and
neither a project's nor a pull request's failure may drop the others.

## The Pull Requests view

The inventory above has exactly one consumer: the **Pull Requests** sidebar
section and the detail page behind it (`app/web/docs/ui-shell.md` owns the shell
side — the section's place in the navigation bar, its browser shape, and the
`worktrees` → `pull-requests` slot migration). This is the part of the contract
that belongs with the pull request itself.

**One local read, two surfaces.** `hooks/usePullRequestInventory.ts` polls
`GET /api/pull-requests` every ~60s WHILE a Pull Requests surface is visible.
That endpoint performs no provider work; it returns the persisted snapshot the
server refreshes in the background. Entering the sidebar section therefore does
not wait on one provider call per registered repository. The detail page
resolves its pull request out of that same projection instead of asking for one
by number, so the list and page cannot disagree about the same pull request.

The browser's local polling stops the moment nothing shows the inventory, while
the server refresh continues. Moving between the index and a detail route keeps
ONE fetch key, so that navigation never blanks the surface.

**Refresh is the user's "read the providers now".** The poll above re-reads only
the snapshot, so a change made on the provider can take up to the five-minute
build period to appear. The list bar's `⋯` and the detail page's object actions
offer **Refresh** (`usePullRequestInventory().refresh`), which calls
`POST /api/pull-requests/refresh` (`refreshPullRequestInventoryNow`). That drops
every provider cache the build would reuse — the project lists, GitHub's
open-list annotations and the per-pull-request reads — marks an in-flight build
obsolete because it may already have read them, joins the one coalesced refresh
and answers with the snapshot it wrote (the `GET` body). It runs regardless of
`ASSISTANT_BACKGROUND_PR_SYNC`, which decides who owns the timer; one explicit
request cannot multiply provider traffic. The client then refetches through the
same keyed read as the poll, also reloads the idle-worktree half of the cleanup
queue, and an open detail page re-reads its conversation with `fresh=1`: a new
comment need not change anything the inventory carries. While it runs the rows
stay under the bar's refresh indicator and the action is busy; a failure is an
error toast and the shown inventory stays. The action's hint is the shown
answer's age (`fetchedAt`), which is what decides whether to press it.

**Grouping, ordering and the row vocabulary are pure**
(`lib/pullRequestInbox.ts`) because every rule in them fails invisibly. By
reason, a row is filed under its STRONGEST reason — **Needs your review**,
**Yours**, **Assigned to you**, **Team review requests**, **Needs cleanup** —
with a review request outranking your own authorship (someone is blocked on it),
a team request the weakest claim, and a terminal pull request always filed under
cleanup (the checkout is its whole reason for being listed). The row's badges
state every other reason. The team group starts folded: a CODEOWNERS rule can
request a team on every pull request of a repository. The list can also be
grouped by project or by date of the last update, and filtered by project, by
reason and by hiding drafts; those choices are browser-local preferences. Within
a group: most recently updated first, an absent `updatedAt` LAST rather than
first, and a tie broken by the row's identity, which makes the order total.

That identity is `projectId#provider#repositoryKey#number` — the client's whole
copy of the server's `pullRequestIdentity.ts` key, over the `repositoryKey`
(`owner/repo`) the item now carries. It is what every React key,
`data-list-row-id`, selection comparison AND the detail ROUTE use
(`/pull-requests/:projectId/:provider/:repositoryKey/:number`, the repository
key percent-encoded as one segment, and a provider this build does not have
rejected outright rather than parsed into an id nothing can resolve).

Each of the four components rules out a collision the others do not, and every
one of them is reachable: two projects; two repositories of ONE project (a
`pushurl` fork, which the server explicitly supports and tests); the same
`owner/repo` under two providers, since that pair is only unique within one; and
two numbers. Addressing on a subset gives two pull requests one URL, highlights
both rows, and opens whichever came first.

**Absent means unknown, in the UI too.** The wire's rule is only worth anything
if the surface honours it, so the vocabulary keeps six answers apart that a
naive renderer collapses into two:

- CI absent on an OPEN pull request is "CI unknown"; absent on a terminal one is
  "no checks", because there is nothing left to have checked. Neither is a pass.
- A review with no `unresolvedThreads` is not "all resolved": that field is
  optional precisely because the REST surfaces cannot always count threads.
- `mergeable: null` is **the provider is still checking** — GitHub answers it
  literally right after a push, and the Forgejo seam maps every draft's `false`
  onto it. It is never drawn as a conflict. `undefined` is "not read at all",
  and a terminal pull request has nothing to merge.

**The local joins are resolved by the client**, against state it already holds:
`worktreeId` against `state.worktrees` plus one live git watch for the detail
page's dirt-and-drift line, `sessionIds` against the session list, `taskIds`
against the Backlog. The section therefore holds the `tasks`, `projects` and
`worktrees` topics while it is visible. The session join is also EXTENDED there
(`pullRequestSessionIds`): every live session row whose `worktreeId` is the pull
request's checkout joins it, because the snapshot only learns of a session at
its next rebuild, and a session started from this page must list at once.

The ids are AUTHORITATIVE and those lists are not, so the page keeps four
answers apart rather than collapsing them into "linked" and "not linked". Zero
ids is the only empty it may claim. A resolved id renders even from a STALE
list, because retained data stays readable. An unresolved id whose list is cold,
stale or failed RESERVES its row — that list is missing exactly what was linked
a moment ago, and an `?? []` there is what made a cold subscription announce
that a pull request implements no Task. Only against a FRESH list is an
unresolved id stated as absent, which is real: an archived session or Task is
never in one, so nothing is coming for that row.

`resolveJoinRows` decides which, and `pullRequestJoinSources` maps app state
onto the three lists WITH their currency in one tested place, reading each
list's own CURRENT-EPISODE flag: `worktreesFresh`/`worktreeListError`,
`taskListFresh`/`taskListError`, and `sessionListFresh`. A failed refresh keeps
the retained rows and states the failure beside them (R2).

`sessionListFresh` exists because the derivation that looks equivalent —
`connected && hydrationSource === "live"` — is wrong in the one window that
matters. `hydrationSource` is historical and survives a disconnect, and the
status reducer turns `connected` back on immediately for a previously-live
shell, BEFORE the new episode's `ready` replaces the session list. In that gap a
session linked a moment ago would be reported as authoritatively absent from
rows belonging to the previous episode. So the flag is set in the `ready` step
that installs `msg.sessions` and nowhere else, cleared on disconnect, and stays
false across a transport reconnect until the next `ready`
(`hooks/useAssistant.test.ts` pins the whole transition).

### The conversation read

The detail page has a SECOND read the list never triggers:
`GET /api/pull-requests/conversation?projectId&provider&repositoryKey&number`
(`pullRequestConversation.ts`), answering one `PullRequestConversationResponse`
— the description, author, assignees, requested reviewers (users and teams), the
timeline of comments and reviews, the inline review threads, and the head's
individual checks. It is per pull request and live, through the provider seam
(`pullRequestConversation` in `gitHosting.ts`, then `refChecks` for the head):
GitHub answers the conversation in one GraphQL query, Forgejo in REST reads of
the pull request, its issue comments, its reviews and each review's comments
(grouped into threads by path and line, resolved when a resolver is set).

The answer is bounded: the last 50 comments and reviews, the last 50 threads
with their first 20 comments, a body cut at 20k characters and a diff hunk at
600, each truncation flagged rather than hidden. A `commented` review with an
empty body is only the envelope of inline replies, which the threads already
show, so it is left out; every verdict stays. Errors are per section
(`errors.conversation`, `errors.checks`): a failed check read never hides the
conversation, and the other way round.

Reads are cached 30 s and concurrent ones coalesce; `&fresh=1` skips the cache.
The client (`hooks/usePullRequestConversation.ts`) reads again, fresh, when the
inventory reports a new head, a newer `updatedAt` or a different CI summary —
the last because a check finishing does not move the pull request's `updatedAt`.

### Resolving provider review threads

`github_get_pull_request` with `includeReviewThreads: true` reads GitHub's
threads through a threads-only GraphQL query in `gitHosting.ts`, without
fetching the description, timeline or reviewer data. Each thread includes its
GraphQL `id`, `resolved` state and comment ids. Use the thread id with
`github_resolve_review_thread` and the decimal-string comment id with
`github_comment_pull_request`'s `replyToCommentId`. The read returns at most the
last 50 threads, keeping the newest when `maxReviews` limits them further, with
the first 20 comments per thread. Returned threads stay oldest first within that
retained window. `reviewThreadsTruncated` flags omitted threads; a thread's
`truncated` flags omitted comments. `includeReviews` similarly retains the
newest submitted reviews, oldest first within the retained window, up to
`maxReviews` and at most 100. Pending reviews do not consume that window.

`github_resolve_review_thread` takes `repo`, PR `number`, `threadId`, and
`resolved`: `true` resolves, `false` reopens. It stages a visible
`githubPullRequest` approval with operation `resolveThread`. Both actions reuse
`github:comment`, so an existing or inherited comment grant covers them. The
executor checks the thread's repository and PR by node id before calling GraphQL
`resolveReviewThread` or `unresolveReviewThread`. A thread already in the
requested state is a read-only success. The approval card shows the PR, thread
id and requested action; the tool does not claim completion before the approval
outcome.

Forgejo's API v1 exposes review comments and their resolver but no operation to
resolve or reopen conversations, so there is no equivalent Forgejo write tool.
This was checked against
[Codeberg's Forgejo OpenAPI specification](https://codeberg.org/swagger.v1.json).
Resolving a thread does not guarantee an external review check immediately turns
green. A review app may react later or start another review round.

### Merge & clean up

The object panel's Actions list carries ONE row for the whole end of a pull
request's life (`app/web/docs/ui-shell.md` places it among the pull request's
other actions), and ONE dialog that lists every consequence with an opt-out
where an opt-out is meaningful. It is the same act the card and the worktree
page perform in pieces, and it reuses their seams rather than forking them:
`pullRequestMerge.ts` for the merge (provider merge + remote branch + every
matching card + the linked Task's `done` SUGGESTION + the targeted base refresh)
and `worktreeRemoval.ts`'s `retireWorktree` for the cleanup (refresh the exact
base target → containment → removal hold → remove → settle sessions).

**The endpoint is its own, because the identity is.** The card's actions are
CARD-bound and the worktree page's merge is WORKTREE-bound; this view has
neither, so `POST /api/pull-requests/merge` (`pullRequestHttp.ts` →
`pullRequestViewMerge.ts`) addresses the pull request by the same four
components as its route and the server's join key.
`POST /api/pull-requests/check` is the same resolution with no side effect — the
state read that answers a client whose action went unanswered; it is a POST
because it takes the same lock, not because it writes. Everything else is
re-derived from that identity server-side — the repository from the project's
own checkouts (asserted to BE `provider#owner/repo`, since one project can hold
two), the head and base branches from a provider read, and the checkout to
remove from the row standing on that head branch IN THAT REPOSITORY. A
same-named branch publishing to a fork is other work and is never removed by
this cleanup. A head branch, SHA or path from the client would let a surface a
minute stale act on something it never showed.

The whole operation runs inside ONE `withPullRequestMutation` (repository
identity + provider + number), so this view and a `/pr` card cannot both act on
the same pull request; the loser is refused before any side effect, never
queued. The merge therefore enters through `mergePullRequestAndProjectLocked`,
the same implementation with the lock already held — an entry point, not a
second path — and the seam's own guards still apply in full: the FORCED
capability read, the last-moment identity re-read, the exact head precondition.

**Two phases, two answers.** Merge first, then clean up, and a merge that LANDED
is never reported as a failure because the cleanup refused afterwards: the
response carries a per-phase outcome (what happened to the remote branch in its
own words, and whether the checkout was retired, refused with its `refusalKind`,
failed, absent or not asked for), plus the Task suggestions the projection
reports it actually WROTE. Merging a pull request with no local worktree works;
the cleanup half is simply absent. A pull request that is already terminal
performs no second merge and runs the cleanup alone — that is the Needs cleanup
group's own button, and it is what makes a refused cleanup retryable.

That rule reaches back into the shared seam: once the provider has ACCEPTED,
every local projection is best-effort. The card patches are wrapped per card
(`patchPullRequestCard` throws for a card that was deleted while the provider
was answering), beside the base refresh and the Workflow records that already
were. A throw there used to become the action's verdict — an unmerged pull
request reported for a merge that is in, and no cleanup — and the watcher
reconciles whatever a failed patch missed anyway. The consequence for THIS
endpoint is exact: an answered refusal means nothing landed, which is what lets
its client tell a refusal from a dropped response.

Best-effort is not the same as unaccounted for, so the projection reports the
cards it actually WROTE (`cardIds`), never the ones it matched. The `/pr` card's
own merge action reads that: a card the projection missed is still open and
still in that action's hands, so its outcome patch carries the terminal state
itself rather than only the message — otherwise clearing `busyAction` would
leave the card offering Merge for a pull request that is already in, until a
watcher poll happened to correct it. The action's final write cannot fail the
action either: an external side effect that landed is never reported as a
failure because its bookkeeping could not be recorded.

**The action drops what the inventory remembers about that pull request.** The
view refetches immediately, and both halves of the projection are caches built
for a poll, so a landed merge (and a cleanup that retired the checkout) calls
`invalidateProjectPullRequests(projectId)` and
`invalidatePullRequestInventoryReads(<provider>#<owner>/<repo>#<number>)` —
both, since dropping one still answers with a merged pull request described as
open. The identity key is derived from the provider that ANSWERED, not assembled
from the request, because only the key the entries were written under can drop
them. Both caches carry a generation: a read that started before an invalidation
still answers its own caller but may not settle into the cache afterwards, or
the action's own refetch would repopulate exactly what it dropped. Other merge
surfaces keep converging on the next poll instead; nothing else refetches this
projection at action time.

**The dialog says what the click will do**, not what was asked for: each
control's sentence follows that control and changes with it, the method picker
offers only `capabilities.mergeMethods` and offers NOTHING while they are
unknown (with the reason), and the branch control appears only where the
repository reports `canDeleteBranchOnMerge`. A known conflict
(`mergeable: false`) disables the action with its reason written out as TEXT
under the control — a tooltip on a disabled button reaches neither a keyboard
nor a phone — while `mergeable: null` is the provider still checking and keeps
merging on offer. The settled sessions and the Task suggestion are STATED, not
opt-outs, and stated as what the server does rather than as a count this browser
cannot promise.

**The consent ladder is the retirement's**, shared with the inspector's Retire
through `lib/worktreeRetire.ts` so the two cannot word the same run differently:
only a refusal `force` can answer is remembered and escalated (a `sessions` one
never is), the refusal is quoted above the consent, and the outcome sentence
reports what the run DID — verified, forced-and-therefore unverified, unverified
without a confirmed check, or a kept branch. Every piece of that state is bound
to the pull request's four-component identity, because a refusal is
consent-bearing and would otherwise arm a forced removal under another pull
request.

Failures stay INLINE on the object: the dialog holds the refusal that it asked
for — and keeps it across a close, since the dialog is the flow that issued the
write and the one place it is retried — and there is no banner. Success is
silent while the object survives — a merge that keeps the checkout leaves the
pull request listed under Needs cleanup, where the state change speaks for
itself. Only when the pull request LEAVES the inventory with its checkout does
the sanctioned toast speak, naming it and reporting the server's own account of
each phase. The inventory is refetched after every attempt rather than patched
locally.

**A failure the server ANSWERED and one that never came back are different
facts**, and the surface says so. An answered refusal (`PullRequestApiError`)
means nothing landed — see the best-effort rule above — so it is stated inline
and the control is the retry. A dropped response is not: the merge may have
landed with the answer lost, so the outcome is UNKNOWN and nothing is offered
from the item on screen, which may predate the attempt.

What ends that uncertainty is `POST /api/pull-requests/check`: what this pull
request IS, read under its own mutation lock and attempting nothing. Two
properties make it the answer. Acquiring the lock PROVES the lost request
finished, so the state it reports is that request's outcome. And because it
performs no merge, no merge guard can refuse it — which a re-issued MERGE cannot
promise: a pull request that has since become a draft, or conflicted, or whose
method the repository stopped allowing, refuses every attempt with an
authoritative guard, and the surface would stay uncertain forever over something
that is merely unmergeable right now.

A refetched inventory answers nothing here however fresh it looks: the lost
request may still HOLD the lock, and the read can have described the repository
from before it merged, so `refreshing → ready` is not evidence and must never
clear the uncertainty (that mistake would re-offer Merge on a pull request that
is already in — the endpoint would refuse it safely as already-terminal, but the
question itself is the lie).

One check is issued automatically. If it cannot be answered — a `busy` refusal
is the lost attempt still running, the one answer that certainly resolves
nothing — the uncertainty stands, survives closing the dialog, and the panel's
row becomes **Check again** rather than the act. When it answers, the
uncertainty ends and the ordinary surface takes over: a TERMINAL answer
suppresses the merge half and leaves the checkout decision (with the sanctioned
toast when nothing local is left, since the pull request is leaving the view),
and an OPEN answer states plainly that the attempt did not merge it and hands
back the ordinary decision — blocked, with its reason as text, when that is what
the pull request now is.

A merge GitHub ACCEPTED but has not confirmed (`merge.status: "pending"`) is the
same uncertainty with its reason attached, and lands in the same state: the
server skips the cleanup (`cleanup.status: "skipped"` when one was asked for,
since removing a checkout whose work may never land is not a cleanup), the
dialog states the server's sentence, and the row offers only **Check again**. No
check is issued automatically here: right after the wait ran out it would mostly
find the pull request still open. The pending answer carries the provider's
`requestId`, and **Check again** sends it back as `mergeRequestId`. A check that
sends none — the provider named no request, or the pending answer itself was
lost and the automatic check runs — falls back to the server's own record of the
attempt by pull-request identity (`pendingMerges.ts`). For an OPEN pull request
the check then reports `mergeRequest`, judged exactly as the watcher judges it:
`pending` (also: could not be asked) and `inconclusive` (no request id to
follow, still within its watch) keep the outcome uncertain, because the request
may still land; `unknown` says the watch ended without an answer; only `failed`
(with the provider's reason, a moved head included) or `expired` lets the check
say it did not merge. Every answer is bound to the attempt it was read for: a
client naming a request other than the current record's (an old tab, an earlier
attempt) is told about ITS attempt alone, and only an answer about the current
record may settle or forget it; a check that names none follows the current
record.

Known follow-ups: the record is memory only. The cards' copy survives a restart,
and the watcher restores the by-identity record from it — but lazily, inside
each card's first poll after boot, so a recovery check served in that startup
gap may not see it yet. A pending merge with no card at all is forgotten by a
restart.

The check's LOCAL answer has three values for the same reason the merge's
cleanup does: `none`, `one` worktree, or `ambiguous` with its reason. Two
checkouts standing on the head branch is a situation to state, not an absence —
reported as absence it would announce that nothing local is left while both are
still there, and hide the cleanup that deals with them.

Retire is the one worktree action this reshuffle moved rather than dropped:
`components/worktree/useWorktreeRetire.tsx`, in the worktree's own inspector
beside Remove. Its consent ladder is unchanged — only a refusal `force` can
answer is remembered and escalated — and every piece of that state is bound to a
WORKTREE ID. A refusal is consent-bearing, so shown under another branch it
would enable a forced retirement there on the strength of a check that ran
somewhere else; the panel survives navigation, which is exactly how that leak
happens. Refusals and transport failures stay inline on the dialog that asked
for them; the success toast is the sanctioned one, because the checkout it names
is gone with its surfaces.

### Review

The view's OTHER workflow, and the other end of a pull request's life: one row
in the object panel that gets you into a session reviewing it. It has two halves
— a local checkout, and a staged session — and the first is where the work is.
The panel also offers the first half ALONE, as **Create worktree** (**Update
worktree** once one exists): the same endpoint, the same convergent act,
stopping short of the session. What it did is reported in the server's terms
(created, brought to the head, already there) on a toast carrying **Start
session** as its action, and the inventory is refetched so the page's local join
shows the checkout. That session action — **Start session in worktree**, the
pull request's primary action — is listed disabled until a worktree holds the
head branch, with creating one as its reason.

**The git capability.** `createWorktree` could only ever mint a NEW branch from
a local base. Reviewing a pull request needs the opposite: a checkout of a
branch that already exists on the remote, TRACKING it, so "bring it to the pull
request's current head" is an ordinary pull rather than a second branch to
reconcile. `CreateWorktreeInput` therefore carries an explicit `source`, absent
meaning today's `new-branch` behaviour byte-for-byte:

- `track-remote` names the remote, the head branch and a PREFERRED base. The
  worktree's own branch IS the head branch — not the requested name, which
  becomes the folder suffix alone — because every local join in this document
  looks for `row.branch === headBranch`, and because only a branch of that name
  can track `<remote>/<head>`.
- The recorded `baseBranch` is the pull request's base WHERE IT EXISTS LOCALLY,
  and the main checkout's current branch otherwise. Never a remote-tracking ref,
  a tag or a SHA: `worktreeMerge.ts` refuses a merge-back unless the main
  checkout is on that exact branch ([Task-246](pa://task/246)), so recording
  `origin/main` there would produce a checkout that looks ordinary in every
  surface and can never merge back. Which of the two was used is REPORTED rather
  than assumed — see the result below.
- The preconditions it will not resolve by guessing are STATED, as a typed
  `WorktreeCreateRefusalError`: a local branch of that name already exists (this
  path never moves a branch it did not create), the remote-tracking ref is not
  there, or there is no local branch left to record as the base (a detached main
  checkout). Classifying those from Git's prose at the call site is how a
  refusal turns into a 500.

**The commit is PINNED, not the ref.** `origin/<head>` moves with every fetch —
including the background `fetchRepoIfDue` that `createWorktree` itself fires
before taking the lock — so the branch is created AT the commit the caller
verified and its upstream configured as a second step, rather than branching off
the remote-tracking ref. Branching off the ref would check out a commit nobody
checked, under a name saying it is the checked one, and report it as `created`.
The pinned commit is re-verified under the lock (a prune or a collection can
have taken it), and its absence is a `head-unreachable` refusal.

The lock rules are the repository's own (`app/server/src/CLAUDE.md`). The fetch
that puts `<remote>/<head>` in reach is network-bound and runs OUTSIDE the repo
lock, under the same exception `worktreeFetch.ts` and `baseCheckoutRefresh.ts`
run under, and the line is that a fetch writing a LOCAL ref is locked. This one
therefore writes exactly one ref and nothing else. `FETCH_HEAD` is the trap: git
writes it for every fetch unless told not to, and both `worktreeSync.ts` and
`baseCheckoutRefresh.ts` READ it under the lock to decide what to rebase onto —
so a lock-free fetch that wrote it could hand a locked operation this pull
request's head as its target. `--no-write-fetch-head` is part of this fetch's
isolation, not a detail, and its argv is asserted rather than described.
Everything that pins the checkout — reading the tracking ref, verifying the
commit, choosing and snapshotting the base, picking a free folder,
`git worktree add`, configuring the upstream — happens under ONE acquisition, as
the new-branch variant already did. Creation stays atomic for the caller: a
failure after the add discards the checkout AND its branch, so a rejected create
leaves nothing behind and the next attempt does not silently land on a `-2`
suffix. Naming still never blocks creation — the folder search is folder-only
here (the branch is already decided) and exhaustion falls back to a timestamp
rather than throwing.

**Update is the other half.** A worktree already standing on that head branch is
brought to the pull request's current head instead of a second one being
created, through `worktreeSync.ts`'s `pull-rebase` — which is already exactly
"bring a tracking branch to its upstream", including the submodule update after
it. What it will not do is guess: a dirty checkout, a branch that carries
commits the pull request's head does not (local work, or a force-push), a
DETACHED checkout or one standing on another branch (it tracks nothing, however
right the commit under it looks), and a branch tracking something other than
this pull request's head are each reported as themselves. No reset, no force, no
re-pointing of a branch this action did not create.

Those checks are made OUTSIDE the lock, so everything they were made against
travels into the operation as a `WorktreeSyncExpectation` and is re-read UNDER
it, before anything is mutated: the branch must still BE the one checked out
there (a detached checkout tracks nothing, and no oid can say otherwise), the
checkout must still stand where it was inspected, the upstream must still be the
one that was checked (`branch.<name>.remote` and `.merge`, not only its commit),
and the fetch `pull-rebase` performs must bring back exactly the verified oid.
Without them the operation's own reads decide what it does — it could land on a
head that moved after the ancestor check, replay a commit that appeared in the
checkout since, or follow an upstream repointed since the `not-tracking` check,
because the configured upstream is ordinary local config and ANY two refs at one
commit satisfy an oid — and each would be reported as the update that was asked
for, leaving a review session open on a checkout that no longer tracks the pull
request. A precondition that no longer holds throws
`WorktreeSyncPreconditionError` and is reported as `raced`, which is not
`update-failed`: nothing was attempted, and asking again reads the state that
overtook it.

**`already-current` is answered there too**, not from the reads. A checkout that
already stands at the pull request's head needs no git work, but "nothing to do"
asserted OUTSIDE the lock is the same claim as "this is what I did" made with
less evidence — the upstream can be repointed in the window, and the answer
would still be `already-current` on a checkout that now follows something else.
So that case goes through the same operation with `head === upstream`: the
branch, the head and the upstream's identity are re-established under the lock
and then `up-to-date` comes back with no fetch and no mutation. Dirt is not
consulted on that path — nothing is being changed, so uncommitted work is in the
way of nothing, which is why the endpoint asks about dirt and divergence only
when there IS something to move.

**The endpoint.** `POST /api/pull-requests/checkout` (`pullRequestHttp.ts` →
`pullRequestViewCheckout.ts`), addressed by the same four components as the
merge and the check, serialized through the same `withPullRequestMutation` so a
checkout and a merge cannot both act on one pull request — the loser is refused
before any side effect. Everything else is re-derived server-side: the
repository from the project's MAIN checkout (asserted to be
`provider#owner/repo` through the shared `pullRequestIdentityThrough`, since one
project can hold two, and it is the main checkout specifically because that is
what a worktree is spawned from), the head and base branches from a provider
read, the commit from the fetch, and the checkout to update from the row
standing on that head branch IN THAT REPOSITORY. A branch, SHA, path or worktree
id from the client would let a surface a minute stale check out something it
never showed.

The head that came back must BE the pull request's head. The fetch is the only
proof that the branch is in reach at all — a pull request opened from a fork has
none here — and a fetch that failed is a refusal with its reason, never a
half-create. It states BOTH readings, because it cannot tell them apart: the
branch is not on this repository, or the remote could not be talked to. Then the
oid is compared with the provider's `headSha`, because a fork's pull request
whose branch name collides with one here would otherwise be checked out as the
reviewed work under the right name, and a head that moved between the read and
the fetch would be checked out as though it were the reviewed one.

**Four outcomes, and refusals are DATA.** The 200 carries `created`, `updated`,
`already-current` or `refused`. `already-current` is its own answer on purpose:
a checkout already standing at the head did no git work, and calling that an
update would claim something that did not happen — the same reason `updated`
reports `previousHead` and `head` from what `pull-rebase` DID rather than from
the commit checked a moment earlier. Every success carries the worktree id, the
branch, the base BLOCK (the recorded merge-back target, the pull request's base,
and whether they are the same) and the checkout's own `taskIds`. A refusal
carries its `kind` (`head-unreachable`, `head-moved`, `dirty`, `diverged`,
`not-tracking`, `branch-exists`, `ambiguous-checkout`, `base-unresolvable`,
`raced`, `update-failed`) and the server's own words, because none of those is a
failed REQUEST — the action attempted nothing it could not report. Only a
request that cannot be resolved at all throws: an identity that names no
repository here (404), a pull request the provider could not be read for (409),
a busy pull request (409).

`taskIds` is on the wire for the same absence-versus-unknown reason as
everything else here, one layer further out. The staged session's Task has to be
chosen the moment the checkout answers, and a browser deciding it from its own
lists would read a Tasks list that has not loaded as "this checkout has no Task"
— silently dropping an authoritative link, or letting a `/pr` card's Task
overrule a checkout-owned one it simply could not see. An empty array from the
server is an ANSWER; a cold list is not.

Those ids are the LIVE Tasks, filtered through `taskSummaryFor` — the same
projection a client's Tasks list is built from, which answers `null` for an
archived Task. Both halves of that matter: an archived id would be ATTACHED on
the first send, and it would also suppress the weaker links that should have
their turn instead, because an edge naming only archived Tasks is SPENT rather
than occupied.

Two checkouts standing on the head branch is `ambiguous-checkout`, on the same
rule as the cleanup's: it is not "no checkout", and adding a third is the one
thing nobody asked for. Nothing is fetched or created in that case.

**The session.** On success the web NAVIGATES to the staged new-session composer
with the project, the returned worktree and the linked Task attached and a
PR-flavoured review prompt prefilled but NOT sent. It reuses `App.tsx`'s
existing staging mechanism — the staged context states plus the composer draft,
shared with the worktree comment review and the `/review` handoff — rather than
building a second one; the prompt is an editable draft, so the shared
review-report convention is appended at the first send exactly as `/review`'s
is. The prompt names the pull request, its number, its `base...head` range and
its URL, because the agent lands in a checkout and that prose is all it has to
tell which change it is looking at.

The Task is derived by the shared rule (`lib/sessionHandoff.ts`), and WHICH Task
it is comes from server ids only. Three tiers, strongest relationship first: the
checkout's own `taskIds` from this answer; a Task claiming a session that runs
in the checkout; the pull request's own links. A tier with SEVERAL live
candidates is ambiguity and stops the derivation — a review must not guess which
Task it is for — while a tier with NONE is spent and hands over to the next,
which is what the worktree handoff already did for an edge whose Tasks have all
been archived.

The browser's lists are consulted only for what they alone can answer, and
travel WITH their currency. The middle tier is the one genuinely client-side
rule, so it is skipped entirely unless both the session and Task lists are
fresh, and an UNKNOWN there stops the derivation rather than falling through to
a weaker link. A FRESH Tasks list is otherwise authoritative in the one
direction it can be: it is the live projection, so an id it does not hold is
SPENT — an archived Task leaves that list rather than appearing with an
`archivedAt`, and staging it would link an archived Task on the first send. A
list that has not answered rules nothing out: its ids survive, and the one that
is chosen is staged under the canonical `Task-<id>` label when no answered list
can name it, since dropping a server-authoritative link because a browser has
not caught up is the other half of the loss this shape exists to prevent.

Runtime and persona stay the ordinary new-session defaults — a review wants an
independent look. The row busies only itself (R5), and success is SILENT: the
navigation is the confirmation. A refusal, and a failure that is not a stated
refusal — a dropped response — are said on a toast NAMING the pull request,
because the row that asked is a menu entry with no durable inline home (closed
on a wide layout the moment it was chosen; a button rather than a failure
surface in the dock); this is the rule the worktree panel's delivery rows
already follow, never a banner. The row stays the retry and the failure says so,
which is honest because the act converges: a checkout whose answer was lost is
found by the next attempt as the existing checkout and merely brought up to
date.

One case is not silent either. A checkout takes seconds and the panel is keyed
by the pull request, so the answer can land after the reader has moved to
another one or out of the section entirely. NAVIGATING then would yank them into
a composer for something they left, so the hand-off does not happen by itself:
the outcome is said in the sanctioned toast NAMING the pull request, carrying
the hand-off as its ACTION. This is the messaging rule's own case — an event
whose surface is gone — not an exception to it.
