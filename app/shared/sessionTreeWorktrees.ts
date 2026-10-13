/**
 * Which worktrees a session's SPAWN TREE owns: the session itself plus every
 * peer it spawned, at any depth, along the durable `spawned` edge
 * (`spawnedBySessionId`) and nothing else — no title, no role word, and no
 * ownership filter, since a peer the user has taken over is still something
 * this session started.
 *
 * A tree owns a worktree when one of its sessions CREATED it (the
 * `created_worktree` edge `worktree_create` records) or RUNS in it (the
 * `in_worktree` edge). The first is what keeps a worktree a coordinator made,
 * and only ever `cd`-ed into or handed to a peer, attributable; the second is
 * every spawned peer, which runs in the worktree it was given. The project's
 * synthetic main checkout is never owned: it is no delivery target and no
 * cleanup candidate.
 *
 * MEMBERSHIP has one authority, the server: every worktree record carries
 * `treeSessionIds` — its holders and every coordinator above them, archived,
 * settled and deleted ones included — and a session's tree owns the worktree
 * exactly when it is listed there ({@link ownedBySessionTree}). The browser
 * never walks its own session list for this: that list leaves out archived
 * sessions, and retention archives every settled peer within a week.
 * {@link sessionTreeWorktrees} adds who holds each owned worktree and how, for
 * a reader that knows the tree's members (`worktree_status`).
 */

/** How one session of the tree holds a worktree. */
export type SessionTreeWorktreeRole = "created" | "runs-in";

export interface SessionTreeWorktreeOwner {
  sessionId: string;
  role: SessionTreeWorktreeRole;
}

/** The fields of a worktree record the ownership rule reads. */
export interface WorktreeOwnershipSource {
  id: string;
  isMain?: boolean;
  sessionIds: readonly string[];
  createdBySessionId?: string;
  treeSessionIds?: readonly string[];
}

/** Whether `sessionId`'s spawn tree owns this worktree, by the server's answer. */
export function ownedBySessionTree(
  worktree: WorktreeOwnershipSource,
  sessionId: string,
): boolean {
  return (
    !worktree.isMain && (worktree.treeSessionIds ?? []).includes(sessionId)
  );
}

export interface SessionTreeWorktree<W extends WorktreeOwnershipSource> {
  worktree: W;
  /** The creator first, then the sessions running in it in record order. */
  owners: SessionTreeWorktreeOwner[];
}

/**
 * The worktrees the tree owns, in the order given, each with the tree sessions
 * that hold it. A session that both created and runs in a worktree is listed
 * once per role.
 */
export function sessionTreeWorktrees<W extends WorktreeOwnershipSource>(
  treeSessionIds: ReadonlySet<string>,
  worktrees: readonly W[],
): SessionTreeWorktree<W>[] {
  const owned: SessionTreeWorktree<W>[] = [];
  for (const worktree of worktrees) {
    if (worktree.isMain) continue;
    const owners: SessionTreeWorktreeOwner[] = [];
    const creator = worktree.createdBySessionId;
    if (creator !== undefined && treeSessionIds.has(creator))
      owners.push({ sessionId: creator, role: "created" });
    for (const sessionId of new Set(worktree.sessionIds))
      if (treeSessionIds.has(sessionId))
        owners.push({ sessionId, role: "runs-in" });
    if (owners.length) owned.push({ worktree, owners });
  }
  return owned;
}
