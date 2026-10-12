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
 * ONE rule for both sides: the server answers `worktree_status`'s tree read
 * with it and the browser derives the coordinator's panel from it, so the two
 * cannot list different worktrees for the same tree.
 */

/** A session as the spawn walk needs it: its id and the edge to its spawner. */
export interface SpawnEdgeSource {
  id: string;
  spawnedBySessionId?: string | undefined;
}

/**
 * The root and every session spawned below it, at any depth. A cycle (no real
 * spawn produces one) is walked once; the root is included even when it is not
 * in `sessions`.
 */
export function spawnTreeSessionIds(
  rootId: string,
  sessions: Iterable<SpawnEdgeSource>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const session of sessions) {
    const parentId = session.spawnedBySessionId;
    if (!parentId || parentId === session.id) continue;
    const siblings = children.get(parentId);
    if (siblings) siblings.push(session.id);
    else children.set(parentId, [session.id]);
  }
  const tree = new Set([rootId]);
  const queue = [rootId];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const childId of children.get(next) ?? []) {
      if (tree.has(childId)) continue;
      tree.add(childId);
      queue.push(childId);
    }
  }
  return tree;
}

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
