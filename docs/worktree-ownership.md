# Worktree ownership

Which sessions a managed worktree belongs to, and how a coordinator that spawns
peers keeps track of every worktree its work produced.

## Two edges

A spawned worktree is tied to sessions by two edges in the generic link graph
(`db/links.ts`), and they answer different questions:

- **`session —in_worktree→ worktree`** — the session RUNS there; its cwd
  resolves to that checkout. A session has at most one: relinking replaces it. A
  first send into a new worktree, `session_spawn` with a `worktreeId`, a fork
  and a Workflow Run's coordinator all write it.
- **`session —created_worktree→ worktree`** — the agent session that CREATED it
  with `worktree_create`. It is written once, at creation, and a worktree that
  already has a creator keeps it. Many per session.

`in_worktree` alone could not hold a coordinator's work: `worktree_create`
deliberately does not move its caller into the new checkout, so a coordinator
that creates three worktrees and hands each to a peer — or only `cd`s into one —
was linked to none of them. Before this edge existed more than half of the
active worktrees had no session linked at all, although the session that created
each was named in its own transcript.

A worktree a person creates, a first send provisions or a Workflow Run starts
has no creator edge: a person is not a session, and the session that runs in a
provisioned checkout is already linked `in_worktree`. Session deletion is soft
and keeps both edges, so a creator may name an archived or deleted session;
whether it still lives is the reader's question.

`WorktreeRecord.createdBySessionId` carries the creator on the wire beside
`sessionIds`.

## A spawn tree's worktrees

A session's SPAWN TREE is the session plus every peer it spawned, at any depth,
along the durable `spawned` edge — whatever the peer's ownership (a peer the
user took over is still something this session started), archive or settlement.
The tree OWNS a worktree when one of its sessions created it or runs in it. The
project's synthetic main checkout is never owned: it is neither a delivery
target nor a cleanup candidate.

Membership has ONE authority, the server. Every spawned worktree record carries
`treeSessionIds` — its holders (creator and the sessions running in it) and
every coordinator above any of them along `spawned` edges, archived, settled and
deleted ones included — and a session's tree owns the worktree exactly when the
session is listed there (`ownedBySessionTree` in
`app/shared/sessionTreeWorktrees.ts`). A list build reads all spawn edges once
(`sessionStore.spawnedParentByChild`) rather than once per row. The browser
never walks its own session list for this: that list leaves out archived
sessions, and retention archives every settled peer within a week, which would
drop exactly the leftover checkouts this exists to find.

Agents read it with `worktree_status` and `sessionTree: true`: the worktrees
owned by the CALLER's tree, each record with its `owners`, plus the tree's root
and size. A peer asking sees its own subtree, not its coordinator's. Each owned
worktree's `owners` (`sessionTreeWorktrees`) name the tree sessions holding it,
the creator first, then those running in it in record order — a session holding
both roles is listed once per role. The tree's members come from one recursive
read that searches the parent-leading primary key at both steps
(`sessionStore.spawnedDescendantIds`); it walks the same edges `treeSessionIds`
walks upward, so the two agree.

## A tree's pull requests

Every owned worktree carries its pull request as the card summary its record
holds (`WorktreeRecord.pullRequest`, `docs/pull-requests.md`), so both readers
of the tree see delivery without a provider call of their own:

- `worktree_status` with `sessionTree: true` returns each record whole, card
  summary included — a coordinator's one read for which of its peers' pull
  requests are open, red, conflicted or merged, and which checkouts are left.
- The session inspector's **Worktrees from this session** group draws the owned
  worktrees — a checkout shared with its peers included; only a tree that owns
  nothing but the worktree the session runs in, which Details names, draws no
  group — as worktree rows with that mark (`app/web/docs/ui-shell.md`). The
  panel holds the Worktrees topic only for a session that has a tree to show: a
  spawned peer in the session list, or worktrees the list it already holds says
  the tree owns (an old coordinator whose peers were archived). While it shows
  them the app holds a git watch on exactly those worktrees, so each row states
  live dirt and drift. Until the list answers, a session with a peer reserves
  the group, or states a failed read with its retry; a failed refresh keeps the
  rows and states the failure beside them.

Nothing here removes a worktree. A merged pull request leaves its checkout where
it is; whether to keep working in it or retire it stays the user's call.

## Idle worktrees: the cleanup queue's other half

The Pull Requests view's **Needs cleanup** group lists a merged or closed pull
request whose checkout is still here. Most checkouts left behind never had a
pull request, so the same view also lists **Idle worktrees**
(`GET /api/worktrees/idle`, `worktrees/idleWorktrees.ts`).

A spawned worktree is IDLE when:

- no session that holds it is live — its creator, the sessions running in it,
  and every coordinator above any of them along the spawn edges, because a
  coordinator may still act on what its peer left. Live is the removal guard's
  own sense: neither settled, archived nor deleted;
- no pull-request card for it is still moving (`choosing-task`, `creating`,
  `open`) — that one is in the pull-request flow;
- no merge is in flight on it;
- no open Workflow Run owns it — a run's role sessions may all be settled
  between steps, and the run still needs its workspace.

Each is classified by its live git status into what retiring it would lose:
`delivered` (clean, and nothing outside the base branch — or its pull request
merged with nothing unpushed after it, since a squash merge lands upstream and
this read never fetches; the retire path verifies against the refreshed base),
`unmerged` (commits the base does not contain, and whether they are pushed),
`uncommitted` (a dirty tree), `missing` (the folder is gone) and `unknown` (git
could not answer, or the base resolves to nothing — never read as delivered).
The read runs git status for the candidates only, four at a time, and only while
the Pull Requests section is on screen (`hooks/useIdleWorktrees.ts`, beside the
inventory's poll).

The read is single-flight and cached for 30 seconds, so every open tab shares
one computation; any retirement drops the cache.

The browser drops a worktree a pull-request row already covers, filters the rest
by the browser's search, orders them safest first and most idle first
(`lib/idleWorktrees.ts`), and draws each with its pull request's mark. A row
opens the worktree, whose own Retire carries the consent ladder. The one bulk
act — **Retire N…** — takes only `delivered` worktrees that SOMEBODY ever held
and nobody touched for a day: a fresh checkout a person made for upcoming work,
or one a first send has not linked yet, is listed but never taken in bulk. It
runs the ordinary retire path one at a time without force (refresh the base,
verify containment, remove, settle) and sends `requireIdle`, so the server
re-asks this whole idle rule for that worktree before AND under its removal hold
(`worktreeIdleRefusal`): the rows are a snapshot, and a session that started
working there since refuses the removal instead of being settled by it. Its
dialog says what "nothing unmerged" does not cover: files git ignores (`.env`,
local databases, caches) go with the checkout. Any refusal stays in the dialog.
Nothing is ever removed automatically.

## The creator backfill

Worktrees created before `worktree_create` recorded its caller get their creator
from a one-time boot backfill (`worktrees/worktreeCreatorBackfill.ts`), run off
the boot path and recorded in `worktree_creator_backfill` (migration 0078) with
its summary. A log that cannot be read is counted (`unreadable`) and skipped;
any other failure records nothing and is retried on the next start. A creator
already recorded is never replaced, and every edge the backfill writes carries
`{ source: "backfill" }` metadata, so exactly those edges can be found again.

The evidence is the creating session's own app log: a `worktree_create` call
(pi's bare name or Claude's `mcp__pa__worktree_create`) and the result paired
with it by `toolCallId`, whose JSON must name the row's id, path and project. A
worktree id merely mentioned — a `worktree_status` listing, a pasted path — is
not a claim. A fork copies its parent's history and stamps every copied entry
`inheritedFrom`; those entries are skipped. As a second guard, the creator must
have EXISTED when the worktree was created, and more than one such claimant
links nothing.

Every session created before the newest candidate is read — `updatedAt` is not a
lifetime bound, since metadata writes are best-effort and a log can hold a turn
its row never recorded — streamed line by line, and only lines that can carry a
call or its result are parsed, the entry's role deciding which. The reader
(`worktreeCreateLogScan.ts`) imports nothing but `node:fs` and `node:readline`,
so it runs as-is under Bun; on the real logs Node and Bun 1.4 return the same
claims. On the deployment it was written for it read about 3,000 logs in under a
minute and named a creator for 559 of 1,047 creator-less rows, with no ambiguous
claim. The rest carry no such evidence: a person, a first send or a Workflow Run
made them, or the log that would say otherwise is gone.
