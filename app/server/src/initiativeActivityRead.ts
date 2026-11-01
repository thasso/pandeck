import {
  workflowRunRoleSessionIds,
  type SessionListItem,
} from "@assistant/shared";
import { initiativeStore } from "./db/initiativeStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  getWorktree,
  sessionIdsForWorktree,
  worktreeIdsForTask,
  worktreeIdBySession,
  type WorktreeRow,
} from "./db/worktreeStore.ts";
import { listRuns } from "./db/workflowStore.ts";
import { workflowRunCardFor } from "./workflowRuns.ts";
import {
  sessionAgent,
  SessionAgentUnreadableError,
} from "./agents/sessionAgent.ts";
import { pullRequestActivityRecords } from "./pullRequestCards.ts";
import {
  associateInitiativeSessions,
  memberActivity,
  isWorkingInitiativeSession,
  type MemberActivity,
} from "./initiativeActivity.ts";

type SessionReader = (ids: string[]) => SessionListItem[];
let testReader: SessionReader | undefined;
/** Keep adapter tests on real stores while supplying live runtime overlays. */
export function setInitiativeActivitySessionReaderForTests(
  reader?: SessionReader,
): void {
  testReader = reader;
}
async function sessionsById(ids: string[]): Promise<SessionListItem[]> {
  if (!ids.length) return [];
  if (testReader) return testReader(ids);
  const { hub } = await import("./hub.ts");
  return hub.listSessions({ includeArchived: true, onlyIds: new Set(ids) });
}

/** At most two bounded session-list batches, no provider calls or harness acquisition. */
export async function readInitiativeActivity(
  initiativeId: string,
  taskIds: readonly string[],
): Promise<Map<string, MemberActivity>> {
  const roots = new Map(taskIds.map((id) => [id, [] as string[]]));
  const trees = new Map(
    taskIds.map((id) => [id, new Map<string, WorktreeRow>()]),
  );
  for (const pair of initiativeStore.memberTaskStarts(Number(initiativeId)))
    roots.get(pair.taskId)?.push(pair.sessionId);
  for (const id of taskIds) {
    for (const worktreeId of worktreeIdsForTask(id)) {
      const row = getWorktree(worktreeId); // Main checkout ids have no spawned-worktree row.
      if (!row) continue;
      trees.get(id)!.set(row.id, row);
      roots.get(id)!.push(...sessionIdsForWorktree(row.id));
    }
    for (const run of listRuns({ taskId: Number(id) })) {
      const card = workflowRunCardFor(run);
      if (card) roots.get(id)!.push(...workflowRunRoleSessionIds(card));
    }
  }
  const parents = sessionStore.spawnedParentByChild();
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents)
    children.set(parent, [...(children.get(parent) ?? []), child]);
  const candidates = new Set<string>();
  const pending = [...roots.values()].flat();
  while (pending.length) {
    const id = pending.pop()!;
    if (candidates.has(id)) continue;
    candidates.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  const rows = await sessionsById([...candidates]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const associated = associateInitiativeSessions(roots, parents, rows);
  const owed = new Set<string>();
  for (const ids of associated.values())
    for (const id of ids) {
      const row = byId.get(id)!;
      if (isWorkingInitiativeSession(row))
        for (const peer of row.awaitingRepliesFrom ?? [])
          if (!byId.has(peer)) owed.add(peer);
    }
  const peers = new Map(byId);
  for (const row of await sessionsById([...owed])) peers.set(row.id, row);
  const heldTrees = worktreeIdBySession();
  const result = new Map<string, MemberActivity>();
  for (const taskId of taskIds) {
    const ids = [...(associated.get(taskId) ?? [])];
    const sessions = ids.map((id) => byId.get(id)!);
    const worktrees = trees.get(taskId)!;
    const agents = new Map<string, string>();
    for (const row of sessions) {
      const treeId = row.worktreeId ?? heldTrees.get(row.id);
      const tree = treeId ? getWorktree(treeId) : undefined;
      if (tree) worktrees.set(tree.id, tree);
      if (isWorkingInitiativeSession(row)) {
        try {
          const agent = sessionAgent(row.id);
          if (agent) agents.set(row.id, agent.name);
        } catch (error) {
          if (!(error instanceof SessionAgentUnreadableError)) throw error;
        }
      }
    }
    const activity = memberActivity(
      sessions,
      peers,
      agents,
      [...worktrees.values()],
      pullRequestActivityRecords([...worktrees.keys()], ids),
    );
    if (
      activity.sessions.length ||
      activity.worktrees.length ||
      activity.pullRequests.length
    )
      result.set(taskId, activity);
  }
  return result;
}
