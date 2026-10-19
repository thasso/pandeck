import {
  backgroundWorkBusy,
  isShelvedSession,
  type SessionListItem,
  type PullRequestCard,
} from "@assistant/shared";
import { pullRequestKey } from "./pullRequestIdentity.ts";

/** Positive roots only; passive Task references never start an association. */
export function associateInitiativeSessions(
  roots: ReadonlyMap<string, readonly string[]>,
  parents: ReadonlyMap<string, string>,
  sessions: readonly SessionListItem[],
): Map<string, Set<string>> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents)
    children.set(parent, [...(children.get(parent) ?? []), child]);
  const owners = new Map<string, Set<string>>();
  for (const [task, ids] of roots)
    for (const id of ids) {
      const tasks = owners.get(id) ?? new Set<string>();
      tasks.add(task);
      owners.set(id, tasks);
    }
  const result = new Map<string, Set<string>>();
  for (const [task, ids] of roots) {
    const associated = new Set<string>();
    const pending = [...ids];
    while (pending.length) {
      const id = pending.pop()!;
      const row = byId.get(id);
      if (!row || associated.has(id)) continue;
      associated.add(id);
      for (const child of children.get(id) ?? []) {
        const item = byId.get(child);
        if (!item || item.spawnOwnership !== "coordinator") continue;
        if (owners.has(child) && !owners.get(child)!.has(task)) continue;
        const refs =
          item.objectRefs?.filter((ref) => ref.objectType === "task") ?? [];
        if (refs.length && !refs.some((ref) => ref.id === task)) continue;
        pending.push(child);
      }
    }
    result.set(task, associated);
  }
  return result;
}

// Mirror sessionInbox.ts isMoving, waitsOnHuman, spawnTreeStall and activityAt.
function moving(s: SessionListItem): boolean {
  return Boolean(
    s.isStreaming ||
    s.queuedWork ||
    (s.delegation &&
      s.delegation.workingCount + s.delegation.startingCount > 0) ||
    backgroundWorkBusy(s.backgroundActivity),
  );
}
function human(s: SessionListItem): boolean {
  return Boolean(
    s.peerPromptHopRefusal ||
    s.awaitingInput ||
    s.attention === "question" ||
    s.attention === "approval" ||
    s.attention === "task-choice",
  );
}
function activityAt(s: SessionListItem): number {
  return Math.max(
    s.updatedAt || 0,
    s.runStartedAt ?? 0,
    s.lastError?.at ?? 0,
    s.interruptedRun?.at ?? 0,
  );
}
function state(s: SessionListItem) {
  return human(s)
    ? "waiting-on-user"
    : moving(s)
      ? "running"
      : s.lastError
        ? "failed"
        : s.interruptedRun
          ? "interrupted"
          : "idle";
}
const priority = [
  "waiting-on-user",
  "running",
  "failed",
  "interrupted",
  "idle",
];
/** Settlement hides quiet history, not resumed work or pending human decisions. */
export function isWorkingInitiativeSession(s: SessionListItem): boolean {
  return !s.archived && (!isShelvedSession(s) || moving(s));
}

export interface ActivityWorktree {
  id: string;
  branch: string;
  status: "active" | "removed";
  createdAt: number;
}
export interface ActivityPullRequestRecord {
  card: PullRequestCard;
  headSha?: string;
}

/** Project full associated sets first, cap only after computing the stall. */
export function memberActivity(
  associated: readonly SessionListItem[],
  peers: ReadonlyMap<string, SessionListItem>,
  agents: ReadonlyMap<string, string>,
  worktrees: readonly ActivityWorktree[],
  records: readonly ActivityPullRequestRecord[],
) {
  const listed = associated
    .filter(isWorkingInitiativeSession)
    .sort(
      (a, b) =>
        priority.indexOf(state(a)) - priority.indexOf(state(b)) ||
        activityAt(b) - activityAt(a) ||
        a.id.localeCompare(b.id),
    );
  const owed = listed
    .flatMap((s) => s.awaitingRepliesFrom ?? [])
    .flatMap((id) => {
      const peer = peers.get(id);
      return peer && isWorkingInitiativeSession(peer) ? [peer] : [];
    });
  const stalled =
    owed.length > 0 && ![...listed, ...owed].some((s) => moving(s) || human(s));
  const grouped = new Map<string, ActivityPullRequestRecord>();
  const movingCard = (c: PullRequestCard) =>
    c.status === "open" ||
    c.status === "creating" ||
    c.status === "choosing-task";
  for (const record of records) {
    const c = record.card;
    const key =
      c.provider && c.url && c.number !== undefined
        ? (pullRequestKey(c.provider, c.url, c.number) ?? c.url)
        : (c.url ?? c.id);
    const previous = grouped.get(key);
    if (
      !previous ||
      (movingCard(c) !== movingCard(previous.card)
        ? movingCard(c)
        : c.createdAt >= previous.card.createdAt)
    )
      grouped.set(key, record);
  }
  const prs = [...grouped.values()].sort(
    (a, b) =>
      Number(movingCard(b.card)) - Number(movingCard(a.card)) ||
      b.card.createdAt - a.card.createdAt,
  );
  const trees = [...worktrees].sort(
    (a, b) =>
      Number(a.status === "removed") - Number(b.status === "removed") ||
      b.createdAt - a.createdAt,
  );
  return {
    ...(stalled ? { stalled: true } : {}),
    sessions: listed.slice(0, 5).map((s) => ({
      id: s.id,
      title: clipTitle(s.title),
      ...(agents.has(s.id) ? { agent: agents.get(s.id) } : {}),
      state: state(s),
      lastActivityAt: new Date(activityAt(s)).toISOString(),
      ...(s.worktreeId ? { worktreeId: s.worktreeId } : {}),
      owedRepliesFrom: (s.awaitingRepliesFrom ?? []).slice(0, 3),
      ...((s.awaitingRepliesFrom?.length ?? 0) > 3
        ? { owedReplyCount: s.awaitingRepliesFrom!.length }
        : {}),
    })),
    ...(listed.length > 5 ? { sessionCount: listed.length } : {}),
    worktrees: trees
      .slice(0, 3)
      .map(({ id, branch, status }) => ({ id, branch, status })),
    ...(trees.length > 3 ? { worktreeCount: trees.length } : {}),
    pullRequests: prs.slice(0, 3).map(({ card: c, headSha }) => ({
      ...(c.number !== undefined ? { number: c.number } : {}),
      ...(c.url ? { url: c.url } : {}),
      status: c.status,
      draft: c.draft ?? false,
      ...(headSha ? { headSha } : {}),
      ...(c.status === "open"
        ? {
            ...(c.ci ? { checks: c.ci.state } : {}),
            ...(c.review ? { review: c.review } : {}),
          }
        : {}),
      ...(c.conflicts !== undefined ? { conflicts: c.conflicts } : {}),
    })),
    ...(prs.length > 3 ? { pullRequestCount: prs.length } : {}),
  };
}
export type MemberActivity = ReturnType<typeof memberActivity>;

function clipTitle(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= 120) return text;
  let out = "";
  for (const char of text) {
    if (Buffer.byteLength(out + char, "utf8") > 117) break;
    out += char;
  }
  return out + "…";
}
