import type { SessionListItem, WorktreeRecord } from "@assistant/shared";
import {
  ALL_PROJECT_FILTER,
  type BacklogProjectFilter,
} from "./backlogTreeModel.ts";
import {
  inboxItemId,
  type SessionInboxItem,
  type SessionInboxTier,
  type SessionInboxView,
} from "./sessionInbox.ts";

export const ATTENTION_FILTER_STATUSES = [
  "needs-you",
  "attention",
  "working",
  "active",
  "settled",
  "archived",
] as const;
export type AttentionFilterStatus = SessionInboxTier | "settled" | "archived";

export interface AttentionFilters {
  project: BacklogProjectFilter;
  /** Empty or all-selected means all states, as in the Task status filter. */
  statuses: AttentionFilterStatus[];
  byProject?: boolean;
}

export const DEFAULT_ATTENTION_FILTERS: AttentionFilters = {
  project: ALL_PROJECT_FILTER,
  statuses: [],
  byProject: false,
};

export function normalizeAttentionFilters(value: unknown): AttentionFilters {
  if (!value || typeof value !== "object") return DEFAULT_ATTENTION_FILTERS;
  const stored = value as Partial<AttentionFilters>;
  const project = stored.project;
  return {
    project:
      project?.kind === "project" &&
      typeof project.projectId === "string" &&
      project.projectId.trim()
        ? { kind: "project", projectId: project.projectId.trim() }
        : project?.kind === "unassigned"
          ? { kind: "unassigned" }
          : ALL_PROJECT_FILTER,
    statuses: ATTENTION_FILTER_STATUSES.filter(
      (status) =>
        Array.isArray(stored.statuses) && stored.statuses.includes(status),
    ),
    byProject: stored.byProject === true,
  };
}

export function attentionFilterCount(filters: AttentionFilters): number {
  return (
    Number(filters.project.kind !== "all") +
    Number(
      filters.statuses.length > 0 &&
        filters.statuses.length < ATTENTION_FILTER_STATUSES.length,
    )
  );
}

/** Match the card's own Project rule, including a session's worktree fallback. */
export function attentionProjectsBySession(
  sessions: readonly SessionListItem[],
  worktrees: readonly WorktreeRecord[] | null,
): Map<string, string | null> {
  const worktreeProjects = new Map(
    (worktrees ?? []).map((worktree) => [worktree.id, worktree.projectId]),
  );
  return new Map(
    sessions.map((session) => [
      session.id,
      session.projectId?.trim() ||
        (session.worktreeId
          ? worktreeProjects.get(session.worktreeId)
          : null) ||
        null,
    ]),
  );
}

/** Group whole units, keeping their manual order inside each Project. Registry
 * order comes first, then unknown Projects, with Unassigned last. */
export function groupAttentionByProject<T>(
  items: readonly T[],
  projectFor: (item: T) => string | null,
  projectOrder: readonly string[],
): { projectId: string | null; items: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const id = projectFor(item);
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  const order = new Map(projectOrder.map((id, index) => [id, index]));
  const rank = (id: string | null) =>
    id === null ? order.size + 1 : (order.get(id) ?? order.size);
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b) || (a ?? "").localeCompare(b ?? ""))
    .map(([projectId, members]) => ({ projectId, items: members }));
}

function matches(
  filters: AttentionFilters,
  projectId: string | null | undefined,
  status: AttentionFilterStatus,
): boolean {
  const projectMatches =
    filters.project.kind === "all" ||
    (filters.project.kind === "unassigned"
      ? !projectId
      : projectId === filters.project.projectId);
  const statusMatches =
    filters.statuses.length === 0 ||
    filters.statuses.length === ATTENTION_FILTER_STATUSES.length ||
    filters.statuses.includes(status);
  return projectMatches && statusMatches;
}

export function attentionHistoryMatches(
  session: SessionListItem,
  status: "settled" | "archived",
  filters: AttentionFilters,
  projects: ReadonlyMap<string, string | null>,
): boolean {
  return matches(filters, projects.get(session.id), status);
}

/** Filter after folding, so matching a peer keeps its coordinator/run intact.
 * Page matching history afterwards, never a page of unrelated history first. */
export function filterAttentionInbox(
  inbox: SessionInboxView,
  filters: AttentionFilters,
  projects: ReadonlyMap<string, string | null>,
  settledLimit: number,
  currentId: string | undefined,
  keepIds: ReadonlySet<string>,
): SessionInboxView {
  const accepts = (item: SessionInboxItem): boolean => {
    if (keepIds.has(inboxItemId(item))) return true;
    if (item.kind === "run") {
      return (
        matches(filters, item.run.projectId, item.tier) ||
        item.roles.some((role) =>
          matches(filters, projects.get(role.session.id), role.tier),
        )
      );
    }
    return (
      matches(filters, projects.get(item.card.session.id), item.card.tier) ||
      Boolean(
        item.card.cluster?.children.some((child) =>
          matches(filters, projects.get(child.session.id), child.tier),
        ),
      )
    );
  };
  const needsYou = inbox.needsYou.filter(accepts);
  const active = inbox.active.filter(accepts);
  const history = inbox.settled.filter((session) =>
    attentionHistoryMatches(session, "settled", filters, projects),
  );
  const settled = history.slice(0, Math.max(0, settledLimit));
  const routed = currentId
    ? history.find((session) => session.id === currentId)
    : undefined;
  if (routed && !settled.some((session) => session.id === routed.id))
    settled.push(routed);
  return {
    needsYou,
    active,
    settled,
    settledHidden: Math.max(0, history.length - settled.length),
    settledTotal: history.length,
    empty: needsYou.length === 0 && active.length === 0 && history.length === 0,
  };
}
