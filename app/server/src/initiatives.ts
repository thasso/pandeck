/**
 * Initiatives — the domain over {@link ./db/initiativeStore.ts}
 * (`docs/initiatives.md`).
 *
 * Every write here is one store mutation: it is validated and written whole or
 * not at all, and the mutation stamps the Initiative's revision and notifies
 * the `initiatives` topic in the same act. Members are resolved at read time
 * (stored members plus their descendants), so the counts and the graph always
 * describe the Tasks as they are now; Task writes reach the Initiatives that
 * hold them through `initiativeStore.touchHolders`, called from the Task
 * notification seam.
 */
import type {
  InitiativeAttention,
  InitiativeDetail,
  InitiativeExternalBlocker,
  InitiativeGraphEdge,
  InitiativeGraphNode,
  InitiativeProgress,
  InitiativeState,
  InitiativeSummary,
  InitiativeTaskState,
  StateDigestEntry,
  StateEvent,
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
  if (!row) throw new Error(`Initiative not found: ${id}`);
  return row;
}

function requireTask(id: string): number {
  const nid = parseId(id);
  if (nid === undefined || !taskStore.get(nid))
    throw new Error(`Task not found: ${id}`);
  return nid;
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

export function createInitiative(input: CreateInitiativeInput): InitiativeRow {
  const title = cleanTitle(input.title);
  return initiativeStore.mutation((touch) => {
    const row = initiativeStore.create(touch, {
      title,
      description: input.description ?? "",
      state: input.state ?? "active",
    });
    addMembersTo(touch, row.id, input.taskIds ?? []);
    return initiativeStore.get(row.id)!;
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

/** Tombstone the Initiative and drop its membership edges; its Tasks stay. */
export function deleteInitiative(id: string): void {
  const current = requireInitiative(id);
  initiativeStore.mutation((touch) => {
    initiativeStore.remove(touch, current.id);
  });
}

/**
 * Add Tasks, each with its whole subtree. A Task already stored is left as it
 * is. A Task inside a member's subtree, or one whose subtree holds a member, is
 * refused with the reason rather than stored twice.
 */
export function addInitiativeMembers(
  id: string,
  taskIds: readonly string[],
): InitiativeRow {
  const current = requireInitiative(id);
  return initiativeStore.mutation((touch) => {
    addMembersTo(touch, current.id, taskIds);
    return initiativeStore.get(current.id)!;
  });
}

function addMembersTo(
  touch: Set<number>,
  initiativeId: number,
  taskIds: readonly string[],
): void {
  for (const raw of taskIds) {
    const taskId = requireTask(raw);
    const stored = new Set(
      initiativeStore.memberEdges(initiativeId).map((edge) => edge.taskId),
    );
    if (stored.has(taskId)) continue;
    const ancestor = ancestorsOf(taskId).find((id) => stored.has(id));
    if (ancestor !== undefined)
      throw new Error(
        `${taskStore.displayId(taskId)} is already a member of ${displayId(initiativeId)} through its ancestor ${taskStore.displayId(ancestor)}, whose whole subtree is included.`,
      );
    const descendant = [...stored].find((member) =>
      ancestorsOf(member).includes(taskId),
    );
    if (descendant !== undefined)
      throw new Error(
        `${taskStore.displayId(taskId)} contains ${taskStore.displayId(descendant)}, which is already a member of ${displayId(initiativeId)}. Remove ${taskStore.displayId(descendant)} first, then add ${taskStore.displayId(taskId)}.`,
      );
    initiativeStore.addMember(touch, initiativeId, taskId);
  }
}

/**
 * Remove stored members. A Task that is not a member is already where the
 * caller wants it; one that is a member only through an ancestor cannot be
 * removed on its own, and the refusal says which ancestor holds it.
 */
export function removeInitiativeMembers(
  id: string,
  taskIds: readonly string[],
): InitiativeRow {
  const current = requireInitiative(id);
  return initiativeStore.mutation((touch) => {
    for (const raw of taskIds) {
      const taskId = parseId(raw);
      if (taskId === undefined) throw new Error(`Task not found: ${raw}`);
      const edges = initiativeStore.memberEdges(current.id);
      if (edges.some((edge) => edge.taskId === taskId)) {
        initiativeStore.removeMember(touch, current.id, taskId);
        continue;
      }
      const holder = holdingEdge(edges, taskId);
      if (holder)
        throw new Error(
          `${taskStore.displayId(taskId)} is a member of ${displayId(current.id)} only through ${taskStore.displayId(holder.taskId)}. Remove ${taskStore.displayId(holder.taskId)}, or move ${taskStore.displayId(taskId)} out of its subtree.`,
        );
    }
    return initiativeStore.get(current.id)!;
  });
}

/** Mark or clear milestones; the mark lives on a stored membership edge. */
export function setInitiativeMilestones(
  id: string,
  taskIds: readonly string[],
  milestone: boolean,
): InitiativeRow {
  const current = requireInitiative(id);
  return initiativeStore.mutation((touch) => {
    for (const raw of taskIds) {
      const taskId = requireTask(raw);
      const edges = initiativeStore.memberEdges(current.id);
      const edge = edges.find((candidate) => candidate.taskId === taskId);
      if (!edge) {
        const holder = holdingEdge(edges, taskId);
        throw new Error(
          holder
            ? `${taskStore.displayId(taskId)} is a member of ${displayId(current.id)} only through ${taskStore.displayId(holder.taskId)}; a milestone is marked on a Task added with addMembers.`
            : `${taskStore.displayId(taskId)} is not a member of ${displayId(current.id)}; add it first.`,
        );
      }
      if (edge.milestone !== milestone)
        initiativeStore.setMilestone(touch, current.id, edge, milestone);
    }
    return initiativeStore.get(current.id)!;
  });
}

/** The stored edge whose subtree holds `taskId`, if one does. */
function holdingEdge(
  edges: readonly InitiativeMemberEdge[],
  taskId: number,
): InitiativeMemberEdge | undefined {
  const ancestors = ancestorsOf(taskId);
  return edges.find((edge) => ancestors.includes(edge.taskId));
}

/** Parent first, up to the root; a stored cycle stops the walk. */
function ancestorsOf(taskId: number): number[] {
  const chain: number[] = [];
  const seen = new Set([taskId]);
  let cursor = taskStore.parentOf(taskId);
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = taskStore.parentOf(cursor);
  }
  return chain;
}

function cleanTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!title) throw new Error("An Initiative needs a title.");
  return title;
}

/* --------------------------------- reads --------------------------------- */

function taskState(member: InitiativeMemberRow): InitiativeTaskState {
  if (member.status === "done") return "done";
  if (member.status === "doing") return "doing";
  return member.openBlockers > 0 ? "blocked" : "startable";
}

function progressOf(
  members: readonly InitiativeMemberRow[],
): InitiativeProgress {
  const progress: InitiativeProgress = {
    total: members.length,
    done: 0,
    doing: 0,
    startable: 0,
    blocked: 0,
  };
  for (const member of members) progress[taskState(member)] += 1;
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
  return {
    id: String(row.id),
    title: row.title,
    state: row.state,
    ...(attention ? { attention } : {}),
    progress: progressOf(members),
    sessionIds: initiativeStore.memberSessionIds(row.id),
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
      state: taskState(member),
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
