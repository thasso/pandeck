/**
 * Initiatives — the domain over {@link ./db/initiativeStore.ts}
 * (`docs/initiatives.md`).
 *
 * Every write here is one store mutation: it is validated and written whole or
 * not at all, and the mutation stamps the Initiative's revision and notifies
 * the `initiatives` topic in the same act. Members are resolved at read time
 * (stored members plus their descendants), so the counts and the graph always
 * describe the Tasks as they are now; Task and session writes reach the
 * Initiatives that read them through the store's fan-out, called from their
 * own notification seams.
 */
import {
  INITIATIVE_SUMMARY_SESSION_LIMIT,
  type InitiativeAttention,
  type InitiativeDetail,
  type InitiativeExternalBlocker,
  type InitiativeGraphEdge,
  type InitiativeGraphNode,
  type InitiativeProgress,
  type InitiativeState,
  type InitiativeSummary,
  type StateDigestEntry,
  type StateEvent,
  type TaskStatus,
} from "@assistant/shared";
import {
  initiativeStore,
  type InitiativeChangeListener,
  type InitiativeMemberEdge,
  type InitiativeMemberRow,
  type InitiativeRow,
} from "./db/initiativeStore.ts";
import { taskStore } from "./db/taskStore.ts";

/** A list entry: the summary, plus when it was archived for archived reads. */
export interface InitiativeListItem extends InitiativeSummary {
  archivedAt?: number;
}

/**
 * What a membership write did beyond its own Tasks: the plain members an added
 * ancestor absorbed, and the removed Tasks that are still members because a
 * member ancestor covers them.
 */
export interface InitiativeMembershipWrite {
  initiative: InitiativeRow;
  absorbedTaskIds: string[];
  stillMembers: Array<{ taskId: string; through: string }>;
}

export function subscribeInitiativeChanges(
  listener: InitiativeChangeListener,
): () => void {
  return initiativeStore.subscribe(listener);
}

/* --------------------------------- ids ----------------------------------- */

function parseId(id: string): number | undefined {
  const n = Number(id.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function displayId(id: number): string {
  return `Initiative-${id}`;
}

function requireInitiative(id: string): InitiativeRow {
  const row = getInitiative(id);
  if (!row) throw new Error(`Initiative not found: ${quoted(id)}`);
  return row;
}

function requireTask(id: string): number {
  const nid = parseId(id);
  if (nid === undefined || !taskStore.get(nid))
    throw new Error(`Task not found: ${quoted(id)}`);
  return nid;
}

/** A caller's id spelling, as an error may repeat it: short, never the input whole. */
function quoted(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 40)}…`;
}

/* -------------------------------- writes --------------------------------- */

export interface CreateInitiativeInput {
  title: string;
  description?: string;
  state?: InitiativeState;
  /** Tasks added as members in the same write. */
  taskIds?: readonly string[];
}

export interface UpdateInitiativeInput {
  title?: string;
  description?: string;
  state?: InitiativeState;
}

export function createInitiative(
  input: CreateInitiativeInput,
): InitiativeMembershipWrite {
  const title = cleanTitle(input.title);
  return initiativeStore.mutation((touch) => {
    const row = initiativeStore.create(touch, {
      title,
      description: input.description ?? "",
      state: input.state ?? "active",
    });
    const absorbed = addMembersTo(touch, row.id, input.taskIds ?? []);
    return membershipWrite(row.id, absorbed, []);
  });
}

export function updateInitiative(
  id: string,
  patch: UpdateInitiativeInput,
): InitiativeRow {
  const current = requireInitiative(id);
  const title = patch.title !== undefined ? cleanTitle(patch.title) : undefined;
  return initiativeStore.mutation((touch) => {
    initiativeStore.update(touch, current.id, {
      ...(title !== undefined ? { title } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
    });
    return initiativeStore.get(current.id)!;
  });
}

export function archiveInitiative(id: string): InitiativeRow {
  return setArchived(id, true);
}

export function unarchiveInitiative(id: string): InitiativeRow {
  return setArchived(id, false);
}

function setArchived(id: string, archived: boolean): InitiativeRow {
  const current = requireInitiative(id);
  return initiativeStore.mutation((touch) => {
    initiativeStore.setArchived(touch, current.id, archived);
    return initiativeStore.get(current.id)!;
  });
}

/**
 * Tombstone the Initiative and drop its membership edges; its Tasks stay.
 * Answers the canonical id it deleted.
 */
export function deleteInitiative(id: string): string {
  const current = requireInitiative(id);
  initiativeStore.mutation((touch) => {
    initiativeStore.remove(touch, current.id);
  });
  return String(current.id);
}

/**
 * Add Tasks, each with its whole subtree. The list is one request, so its
 * order does not matter:
 * - a Task already stored is left as it is;
 * - a Task a member already covers is refused with the reason, and the whole
 *   operation with it;
 * - a Task under another Task in the same list is absorbed into it;
 * - a Task holding plain members absorbs them: their edges go, while marked
 *   (milestone) edges below it stay.
 * Existing members keep their places, and the Tasks added are appended after
 * them in the order they were given in; an absorbed edge leaves no slot.
 */
export function addInitiativeMembers(
  id: string,
  taskIds: readonly string[],
): InitiativeMembershipWrite {
  const current = requireInitiative(id);
  return initiativeStore.mutation((touch) => {
    const absorbed = addMembersTo(touch, current.id, taskIds);
    return membershipWrite(current.id, absorbed, []);
  });
}

function addMembersTo(
  touch: Set<number>,
  initiativeId: number,
  taskIds: readonly string[],
): number[] {
  const requested = [...new Set(taskIds.map(requireTask))];
  const edges = initiativeStore.memberEdges(initiativeId);
  const stored = new Set(edges.map((edge) => edge.taskId));
  const fresh = requested.filter((taskId) => !stored.has(taskId));
  for (const taskId of fresh) {
    const covering = coveringEdge(edges, taskId);
    if (covering)
      throw new Error(
        `${taskStore.displayId(taskId)} is already a member of ${displayId(initiativeId)} through its ancestor ${taskStore.displayId(covering.taskId)}, whose whole subtree is included.`,
      );
  }
  const inList = new Set(fresh);
  const ancestors = new Map(
    fresh.map((taskId) => [taskId, initiativeStore.ancestorIds(taskId)]),
  );
  const roots = fresh.filter(
    (taskId) =>
      !ancestors.get(taskId)!.some((ancestor) => inList.has(ancestor)),
  );
  const absorbed = fresh.filter((taskId) => !roots.includes(taskId));
  for (const root of roots) {
    const below = initiativeStore
      .memberEdges(initiativeId)
      .filter(
        (edge) =>
          !edge.milestone &&
          initiativeStore.ancestorIds(edge.taskId).includes(root),
      );
    for (const edge of below)
      initiativeStore.removeMember(touch, initiativeId, edge.taskId);
    initiativeStore.addMember(touch, initiativeId, root);
    absorbed.push(...below.map((edge) => edge.taskId));
  }
  return absorbed;
}

/**
 * Remove stored members. A Task that is not a member is already where the
 * caller wants it; one that is a member only through an ancestor cannot be
 * removed on its own, and the refusal says which ancestor holds it. Removing a
 * stored edge under a member ancestor (a marked one) leaves the Task a member
 * through that ancestor; the answer says so as of the END of the operation, so
 * an ancestor the same list removes covers nothing.
 */
export function removeInitiativeMembers(
  id: string,
  taskIds: readonly string[],
): InitiativeMembershipWrite {
  const current = requireInitiative(id);
  return initiativeStore.mutation((touch) => {
    const removed: number[] = [];
    for (const raw of taskIds) {
      const taskId = parseId(raw);
      if (taskId === undefined)
        throw new Error(`Task not found: ${quoted(raw)}`);
      const edges = initiativeStore.memberEdges(current.id);
      if (edges.some((edge) => edge.taskId === taskId)) {
        initiativeStore.removeMember(touch, current.id, taskId);
        removed.push(taskId);
        continue;
      }
      const covering = coveringEdge(edges, taskId);
      if (covering)
        throw new Error(
          `${taskStore.displayId(taskId)} is a member of ${displayId(current.id)} only through ${taskStore.displayId(covering.taskId)}. Remove ${taskStore.displayId(covering.taskId)}, or move ${taskStore.displayId(taskId)} out of its subtree.`,
        );
    }
    return membershipWrite(
      current.id,
      [],
      initiativeMembershipNow(String(current.id), removed.map(String)),
    );
  });
}

/**
 * Mark or clear milestones. The mark lives on a membership edge: marking a
 * Task covered by a member stores a marked edge for it, and clearing that mark
 * deletes the edge again (the Task stays a member through its ancestor);
 * clearing an uncovered Task's mark keeps it as a plain member.
 */
export function setInitiativeMilestones(
  id: string,
  taskIds: readonly string[],
  milestone: boolean,
): InitiativeMembershipWrite {
  const current = requireInitiative(id);
  return initiativeStore.mutation((touch) => {
    for (const raw of taskIds) {
      const taskId = requireTask(raw);
      const edges = initiativeStore.memberEdges(current.id);
      const edge = edges.find((candidate) => candidate.taskId === taskId);
      const covering = coveringEdge(
        edges.filter((candidate) => candidate.taskId !== taskId),
        taskId,
      );
      if (!edge && !covering)
        throw new Error(
          `${taskStore.displayId(taskId)} is not a member of ${displayId(current.id)}; add it first.`,
        );
      if (milestone) {
        if (!edge) initiativeStore.addMember(touch, current.id, taskId, true);
        else if (!edge.milestone)
          initiativeStore.setMilestone(touch, current.id, edge, true);
      } else if (edge?.milestone) {
        if (covering) initiativeStore.removeMember(touch, current.id, taskId);
        else initiativeStore.setMilestone(touch, current.id, edge, false);
      }
    }
    return membershipWrite(current.id, [], []);
  });
}

/** The stored edge whose subtree holds `taskId`, nearest ancestor first. */
function coveringEdge(
  edges: readonly InitiativeMemberEdge[],
  taskId: number,
): InitiativeMemberEdge | undefined {
  const byTask = new Map(edges.map((edge) => [edge.taskId, edge]));
  for (const ancestor of initiativeStore.ancestorIds(taskId)) {
    const edge = byTask.get(ancestor);
    if (edge) return edge;
  }
  return undefined;
}

function membershipWrite(
  initiativeId: number,
  absorbed: readonly number[],
  stillMembers: InitiativeMembershipWrite["stillMembers"],
): InitiativeMembershipWrite {
  return {
    initiative: initiativeStore.get(initiativeId)!,
    absorbedTaskIds: absorbed.map(String),
    stillMembers,
  };
}

/**
 * Which of `taskIds` hold no stored edge of the Initiative NOW but are members
 * through a member ancestor, and that ancestor. Read from the current edges,
 * so a caller asks after its writes and gets the state they left.
 */
export function initiativeMembershipNow(
  id: string,
  taskIds: readonly string[],
): InitiativeMembershipWrite["stillMembers"] {
  const nid = parseId(id);
  if (nid === undefined || !initiativeStore.get(nid)) return [];
  const edges = initiativeStore.memberEdges(nid);
  const stored = new Set(edges.map((edge) => edge.taskId));
  const result: InitiativeMembershipWrite["stillMembers"] = [];
  for (const raw of new Set(taskIds)) {
    const taskId = parseId(raw);
    if (taskId === undefined || stored.has(taskId)) continue;
    const covering = coveringEdge(edges, taskId);
    if (covering)
      result.push({ taskId: String(taskId), through: String(covering.taskId) });
  }
  return result;
}

function cleanTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!title) throw new Error("An Initiative needs a title.");
  return title;
}

/* --------------------------------- reads --------------------------------- */

/** Blocked is independent of status: an open blocker on a Task not done. */
function isBlocked(member: InitiativeMemberRow): boolean {
  return member.status !== "done" && member.openBlockers > 0;
}

function progressOf(
  members: readonly InitiativeMemberRow[],
): InitiativeProgress {
  return initiativeProgressOf(members, isBlocked);
}

/**
 * Counts per `docs/initiatives.md`: every member in `total`, every done one in
 * `done`, and only unarchived members in `doing`, `startable` and `blocked` —
 * a shelved Task is neither work in progress nor work that could start.
 */
export function initiativeProgressOf<
  T extends { status: TaskStatus; archived?: boolean },
>(members: readonly T[], blocked: (member: T) => boolean): InitiativeProgress {
  const progress: InitiativeProgress = {
    total: members.length,
    done: 0,
    doing: 0,
    startable: 0,
    blocked: 0,
  };
  for (const member of members) {
    if (member.status === "done") {
      progress.done += 1;
      continue;
    }
    if (member.archived) continue;
    if (member.status === "doing") progress.doing += 1;
    if (blocked(member)) progress.blocked += 1;
    else if (member.status === "todo") progress.startable += 1;
  }
  return progress;
}

function attentionOf(row: InitiativeRow): InitiativeAttention | undefined {
  if (row.attentionRevision <= 0) return undefined;
  return {
    revision: row.attentionRevision,
    settledRevision: row.attentionSettledRevision,
    kind: row.attentionKind ?? (row.state === "done" ? "done" : "paused"),
    at: row.attentionAt ?? row.updatedAt,
  };
}

function summaryOf(
  row: InitiativeRow,
  members: readonly InitiativeMemberRow[],
): InitiativeSummary {
  const attention = attentionOf(row);
  const sessions = initiativeStore.memberSessions(
    row.id,
    INITIATIVE_SUMMARY_SESSION_LIMIT,
  );
  return {
    id: String(row.id),
    title: row.title,
    state: row.state,
    ...(attention ? { attention } : {}),
    progress: progressOf(members),
    sessionIds: sessions.ids,
    sessionCount: sessions.count,
    updatedAt: row.updatedAt,
  };
}

/** One Initiative's own row, archived or not; deleted ones are gone. */
export function getInitiative(id: string): InitiativeRow | undefined {
  const nid = parseId(id);
  return nid === undefined ? undefined : initiativeStore.get(nid);
}

/**
 * An Initiative's current state-event revision, for a reply carrying its graph:
 * the client re-reads the graph only on an event newer than this.
 */
export function initiativeRevision(id: string): number | undefined {
  return getInitiative(id)?.revision;
}

/** The `initiatives` topic projection of one live Initiative, or null. */
export function initiativeSummaryFor(id: string): InitiativeSummary | null {
  const nid = parseId(id);
  const row = nid === undefined ? undefined : initiativeStore.get(nid);
  if (!row || row.archivedAt !== undefined) return null;
  return summaryOf(row, initiativeStore.members(row.id));
}

export function listInitiatives(
  filter: {
    state?: InitiativeState;
    query?: string;
    includeArchived?: boolean;
  } = {},
): InitiativeListItem[] {
  const query = filter.query?.trim().toLowerCase();
  return initiativeStore
    .list({ includeArchived: filter.includeArchived === true })
    .filter((row) => !filter.state || row.state === filter.state)
    .filter(
      (row) =>
        !query ||
        row.title.toLowerCase().includes(query) ||
        row.description.toLowerCase().includes(query),
    )
    .map((row) => ({
      ...summaryOf(row, initiativeStore.members(row.id)),
      ...(row.archivedAt !== undefined ? { archivedAt: row.archivedAt } : {}),
    }));
}

/**
 * One Initiative with its graph, archived or not: the members depth-first from
 * the roots, the `blocks` links into them (outside blockers as stubs), and the
 * milestones. Never a Task description.
 */
export function readInitiative(id: string): InitiativeDetail | null {
  const nid = parseId(id);
  const row = nid === undefined ? undefined : initiativeStore.get(nid);
  if (!row) return null;
  const members = initiativeStore.members(row.id);
  const edges = initiativeStore.memberEdges(row.id);
  const byId = new Map(members.map((member) => [member.taskId, member]));
  const direct = new Map(edges.map((edge) => [edge.taskId, edge]));
  const graphParent = (member: InitiativeMemberRow): number | undefined =>
    member.parentId !== undefined && byId.has(member.parentId)
      ? member.parentId
      : undefined;

  const children = new Map<number, InitiativeMemberRow[]>();
  for (const member of members) {
    const parent = graphParent(member);
    if (parent === undefined) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(member);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort(backlogOrder);

  const rootIds = edges
    .map((edge) => edge.taskId)
    .filter((taskId) => {
      const member = byId.get(taskId);
      return member !== undefined && graphParent(member) === undefined;
    });
  const nodes: InitiativeGraphNode[] = [];
  const placed = new Set<number>();
  const visit = (member: InitiativeMemberRow): void => {
    if (placed.has(member.taskId)) return;
    placed.add(member.taskId);
    const edge = direct.get(member.taskId);
    const parent = graphParent(member);
    nodes.push({
      id: String(member.taskId),
      title: member.title,
      status: member.status,
      ...(isBlocked(member) ? { blocked: true as const } : {}),
      ...(member.projectId ? { projectId: member.projectId } : {}),
      ...(parent !== undefined ? { parentId: String(parent) } : {}),
      ...(edge ? { direct: true as const } : {}),
      ...(edge?.milestone ? { milestone: true as const } : {}),
      ...(member.archived ? { archived: true as const } : {}),
    });
    for (const child of children.get(member.taskId) ?? []) visit(child);
  };
  for (const rootId of rootIds) visit(byId.get(rootId)!);
  // Only a stored hierarchy cycle leaves members unreached from a root.
  for (const member of [...members].sort(backlogOrder)) visit(member);

  const blockers = initiativeStore.blockersInto(
    members.map((member) => member.taskId),
  );
  const externalBlockers = new Map<number, InitiativeExternalBlocker>();
  const graphEdges: InitiativeGraphEdge[] = [];
  for (const blocker of blockers) {
    graphEdges.push({ from: String(blocker.fromId), to: String(blocker.toId) });
    if (byId.has(blocker.fromId) || externalBlockers.has(blocker.fromId))
      continue;
    externalBlockers.set(blocker.fromId, {
      id: String(blocker.fromId),
      title: blocker.title,
      status: blocker.status,
      ...(blocker.projectId ? { projectId: blocker.projectId } : {}),
      ...(blocker.archived ? { archived: true as const } : {}),
    });
  }

  return {
    ...summaryOf(row, members),
    description: row.description,
    createdAt: row.createdAt,
    ...(row.archivedAt !== undefined ? { archivedAt: row.archivedAt } : {}),
    rootIds: rootIds.map(String),
    nodes,
    externalBlockers: [...externalBlockers.values()],
    edges: graphEdges,
    milestoneIds: edges
      .filter((edge) => edge.milestone && byId.has(edge.taskId))
      .map((edge) => String(edge.taskId)),
  };
}

function backlogOrder(a: InitiativeMemberRow, b: InitiativeMemberRow): number {
  return (
    (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.sortOrder ?? Number.MAX_SAFE_INTEGER) || a.taskId - b.taskId
  );
}

/* --------------------------- state-change sync --------------------------- */

export function initiativeRevisionIndex(): Map<
  string,
  { revision: number; live: boolean }
> {
  return new Map(
    initiativeStore
      .revisions()
      .map((row) => [
        String(row.id),
        { revision: row.revision, live: row.live },
      ]),
  );
}

/** The compact revision digest of exactly the live projection. */
export function initiativeRevisionDigest(): StateDigestEntry[] {
  return initiativeStore
    .revisions()
    .filter((row) => row.live)
    .map((row) => ({ id: String(row.id), revision: row.revision }));
}

/** Targeted catch-up after a digest diff, as ordinary state events. */
export function initiativeStateItems(
  ids: readonly string[],
): StateEvent<InitiativeSummary>[] {
  const index = initiativeRevisionIndex();
  const events: StateEvent<InitiativeSummary>[] = [];
  for (const id of new Set(ids)) {
    const entry = index.get(id);
    if (!entry) continue;
    const item = entry.live ? initiativeSummaryFor(id) : null;
    events.push(
      item
        ? { kind: "upsert", id, revision: entry.revision, item }
        : { kind: "delete", id, revision: entry.revision },
    );
  }
  return events;
}

/** Every live summary and its revision: the cold subscribe answer. */
export function initiativeSnapshot(): {
  items: InitiativeSummary[];
  revisions: StateDigestEntry[];
} {
  const revisions = initiativeRevisionDigest();
  const items = revisions
    .map((entry) => initiativeSummaryFor(entry.id))
    .filter((item): item is InitiativeSummary => item !== null);
  return { items, revisions };
}
