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

That rule is one pure module, `app/shared/sessionTreeWorktrees.ts`
(`spawnTreeSessionIds`, `sessionTreeWorktrees`), so every surface that lists a
tree's worktrees lists the same ones. Each owned worktree carries its owners in
a fixed order: the creator first, then the tree sessions running in it in record
order; a session holding both roles is listed once per role.

Agents read it with `worktree_status` and `sessionTree: true`: the worktrees
owned by the CALLER's tree, each record with its `owners`, plus the tree's root
and size. A peer asking sees its own subtree, not its coordinator's. The server
walks the tree in one recursive read over `session_links_parent_idx`
(`sessionStore.spawnedDescendantIds`).

## The creator backfill

Worktrees created before `worktree_create` recorded its caller get their creator
from a one-time boot backfill (`worktrees/worktreeCreatorBackfill.ts`), run off
the boot path and recorded in `worktree_creator_backfill` (migration 0078) with
its summary. A failure records nothing and is retried on the next start; a
creator already recorded is never replaced.

The evidence is the creating session's own app log: a `worktree_create` call
(pi's bare name or Claude's `mcp__pa__worktree_create`) and the result paired
with it by `toolCallId`, whose JSON must name the row's id, path and project. A
worktree id merely mentioned — a `worktree_status` listing, a pasted path — is
not a claim. A fork copies its parent's history, so the same call and result
appear in every fork made after it; the creator is the claimant that EXISTED
when the worktree was created, and more than one such claimant links nothing.

Only sessions whose lifetime overlaps the candidates' creation times are read,
streamed line by line, and only lines that can carry a call or its result are
parsed. On the deployment it was written for it read about 3,000 logs in under a
minute and named a creator for 559 of 1,047 creator-less rows, with no ambiguous
claim; the rest were made by a person, a first send or a Workflow Run.
