import { workflowRunRoleSessionIds } from "@assistant/shared";
import type {
  InitiativeGraphNode,
  InitiativeSummary,
  SessionListItem,
  WorkflowRunCard,
  WorkflowRunSummary,
  WorktreeRecord,
} from "@assistant/shared";

/** Positive Task membership, never all sessions in a Project or checkout. */
export function initiativeBrowserSessions({
  initiative,
  members,
  sessions,
  worktrees,
  runs,
  cards,
}: {
  initiative: InitiativeSummary;
  members: readonly InitiativeGraphNode[];
  sessions: readonly SessionListItem[];
  worktrees: readonly WorktreeRecord[];
  runs: readonly WorkflowRunSummary[] | null;
  cards: Readonly<Record<string, WorkflowRunCard>>;
}) {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const projectIds = new Set(members.map((member) => member.projectId));
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const scoped = new Set(initiative.sessionIds);
  let incomplete = initiative.sessionCount > initiative.sessionIds.length;
  for (const session of sessions) {
    if (
      session.objectRefs?.some(
        (ref) => ref.objectType === "task" && memberById.has(ref.id),
      )
    )
      scoped.add(session.id);
  }
  for (const run of runs ?? []) {
    if (!memberById.has(run.taskId)) continue;
    const card = cards[run.id];
    if (card) for (const id of workflowRunRoleSessionIds(card)) scoped.add(id);
    else incomplete = true;
  }
  // Inherit only an owned spawn relationship from an already scoped session.
  // Explicit Task context outside the Initiative takes precedence over that
  // inheritance; a taken-over or unknown peer needs its own positive evidence.
  const children = new Map<string, SessionListItem[]>();
  for (const session of sessions) {
    if (session.spawnOwnership !== "coordinator" || !session.spawnedBySessionId)
      continue;
    const taskRefs =
      session.objectRefs?.filter((ref) => ref.objectType === "task") ?? [];
    if (taskRefs.length > 0 && !taskRefs.some((ref) => memberById.has(ref.id)))
      continue;
    if (
      session.projectId &&
      !projectIds.has(session.projectId) &&
      !scoped.has(session.id)
    )
      continue;
    const peers = children.get(session.spawnedBySessionId) ?? [];
    peers.push(session);
    children.set(session.spawnedBySessionId, peers);
  }
  const queue = [...scoped];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index]!) ?? []) {
      if (scoped.has(child.id)) continue;
      scoped.add(child.id);
      queue.push(child.id);
    }
  }

  const worktreeById = new Map(
    worktrees.map((worktree) => [worktree.id, worktree]),
  );
  const worktreeBySession = new Map(
    worktrees.flatMap((worktree) =>
      worktree.sessionIds.map((id) => [id, worktree.id] as const),
    ),
  );
  const byWorktree = new Map<string, SessionListItem[]>();
  const byProject = new Map<string | undefined, SessionListItem[]>();
  const unplaced: SessionListItem[] = [];
  for (const id of scoped) {
    const session = byId.get(id);
    if (!session) {
      incomplete = true;
      continue;
    }
    if (session.archived && !session.isStreaming) continue;
    const worktreeId = session.worktreeId ?? worktreeBySession.get(id);
    if (worktreeId) {
      const worktree = worktreeById.get(worktreeId);
      if (
        worktree &&
        worktree.status !== "removed" &&
        projectIds.has(worktree.projectId)
      ) {
        const rows = byWorktree.get(worktreeId) ?? [];
        rows.push(session);
        byWorktree.set(worktreeId, rows);
      } else unplaced.push(session);
      continue;
    }
    let projectId: string | undefined;
    let placed = false;
    let current: SessionListItem | undefined = session;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.projectId && projectIds.has(current.projectId)) {
        projectId = current.projectId;
        placed = true;
        break;
      }
      const taskProjects = new Set(
        (current.objectRefs ?? [])
          .filter((ref) => ref.objectType === "task" && memberById.has(ref.id))
          .map((ref) => memberById.get(ref.id)!.projectId),
      );
      if (taskProjects.size === 1) {
        projectId = [...taskProjects][0];
        placed = true;
        break;
      }
      current =
        current.spawnedBySessionId && scoped.has(current.spawnedBySessionId)
          ? byId.get(current.spawnedBySessionId)
          : undefined;
    }
    // With one member Project, a Task-scoped session has unambiguous placement.
    if (!placed && projectIds.size === 1) {
      projectId = [...projectIds][0];
      placed = true;
    }
    if (placed) {
      const rows = byProject.get(projectId) ?? [];
      rows.push(session);
      byProject.set(projectId, rows);
    } else unplaced.push(session);
  }
  for (const worktree of worktrees) {
    if (!worktree.taskIds.some((id) => memberById.has(id))) continue;
    for (const id of worktree.sessionIds) {
      const session = byId.get(id);
      if (
        !session ||
        (!scoped.has(id) &&
          !session.objectRefs?.some((ref) => ref.objectType === "task"))
      )
        incomplete = true;
    }
  }
  const compare = (a: SessionListItem, b: SessionListItem) =>
    Number(Boolean(b.isStreaming)) - Number(Boolean(a.isStreaming)) ||
    b.updatedAt - a.updatedAt ||
    a.id.localeCompare(b.id);
  for (const rows of [...byWorktree.values(), ...byProject.values(), unplaced])
    rows.sort(compare);
  return { byWorktree, byProject, unplaced, incomplete };
}
