/**
 * The `initiatives` store (`docs/initiatives.md`).
 *
 * The row holds the Initiative's own columns. Membership is an
 * `initiative —member→ task` edge in the generic {@link ./links.ts} graph,
 * `position` for the user's order and `{ "milestone": true }` in its metadata.
 * A PLAIN edge is stored only for a Task no other member covers: its
 * descendants are members by being under it, resolved here at read time. A
 * MARKED edge (a milestone) may sit under a member, since it carries the mark.
 *
 * Every Initiative write goes through {@link mutation}, which stamps the
 * touched rows' revisions in the same transaction and notifies once they are
 * stamped, so a bump and its notification cannot diverge
 * (docs/state-sync.md). Task and session writes reach the Initiatives that
 * read them through {@link touchHolders} and {@link touchSessionHolders}, the
 * same seam.
 */
import type { InitiativeState } from "@assistant/shared";
import { getDb, inDbTransaction } from "./index.ts";
import { nextId } from "./sequences.ts";
import {
  addLink,
  incoming,
  outgoing,
  removeAllFor,
  removeLink,
  type NodeRef,
} from "./links.ts";
import { sessionStore } from "./sessionStore.ts";

type TaskStatus = "todo" | "doing" | "done";

export interface InitiativeRow {
  id: number;
  title: string;
  description: string;
  state: InitiativeState;
  revision: number;
  attentionRevision: number;
  attentionSettledRevision: number;
  attentionKind?: Exclude<InitiativeState, "active">;
  attentionAt?: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

/** One stored membership edge: a Task added, or marked, in the Initiative. */
export interface InitiativeMemberEdge {
  taskId: number;
  position: number;
  milestone: boolean;
}

/** One resolved member: a stored member or a live descendant of one. */
export interface InitiativeMemberRow {
  taskId: number;
  title: string;
  status: TaskStatus;
  sortOrder?: number;
  archived: boolean;
  /** The Task's parent, member or not. */
  parentId?: number;
  projectId?: string;
  /** Blockers neither done nor archived, the `openBlockerCounts` rule. */
  openBlockers: number;
}

/** A `blocks` link into a member, with the blocking Task's display fields. */
interface InitiativeBlockerEdge {
  fromId: number;
  toId: number;
  title: string;
  status: TaskStatus;
  archived: boolean;
  projectId?: string;
}

export type InitiativeChangeListener = (ids: readonly string[]) => void;

const listeners = new Set<InitiativeChangeListener>();

function subscribe(listener: InitiativeChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function initiativeNode(id: number): NodeRef {
  return { type: "initiative", id: String(id) };
}

function taskNode(id: number): NodeRef {
  return { type: "task", id: String(id) };
}

/**
 * Run `fn` atomically, stamp every Initiative it touched with the next
 * `initiative_revision` value inside the same transaction, and notify once it
 * is written. A write that throws touches nothing and notifies nobody.
 *
 * Inside a caller's open transaction (a session tombstone that is part of a
 * larger delete) the stamp joins it: a rollback takes the stamp with it, and
 * the listeners only schedule a debounced flush that reads committed state.
 */
function mutation<T>(fn: (touch: Set<number>) => T): T {
  const { value, touched } = inDbTransaction(() => {
    const touched = new Set<number>();
    const value = fn(touched);
    if (touched.size) {
      const revision = nextId("initiative_revision");
      const stamp = getDb().prepare(
        "UPDATE initiatives SET revision = ? WHERE id = ?",
      );
      for (const id of touched) stamp.run(revision, id);
    }
    return { value, touched };
  });
  if (touched.size) {
    const ids = [...touched].map(String);
    for (const listener of listeners) {
      try {
        listener(ids);
      } catch {
        // A listener cannot make an already durable write fail.
      }
    }
  }
  return value;
}

/* --------------------------------- rows ---------------------------------- */

function create(
  touch: Set<number>,
  input: { title: string; description: string; state: InitiativeState },
): InitiativeRow {
  const id = nextId("initiative");
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO initiatives (id, title, description, state, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.title, input.description, input.state, now, now);
  touch.add(id);
  return get(id)!;
}

/** A live or archived Initiative; tombstoned rows are gone. */
function get(id: number): InitiativeRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM initiatives WHERE id = ? AND deleted_at_ms IS NULL")
    .get(id) as DbInitiativeRow | undefined;
  return row ? fromRow(row) : undefined;
}

function list(filter: { includeArchived?: boolean } = {}): InitiativeRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM initiatives WHERE deleted_at_ms IS NULL
       ${filter.includeArchived ? "" : "AND archived_at_ms IS NULL"}
       ORDER BY updated_at_ms DESC, id DESC`,
    )
    .all() as unknown as DbInitiativeRow[];
  return rows.map(fromRow);
}

function update(
  touch: Set<number>,
  id: number,
  patch: { title?: string; description?: string; state?: InitiativeState },
): void {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description);
  }
  if (patch.state !== undefined) {
    sets.push("state = ?");
    params.push(patch.state);
  }
  sets.push("updated_at_ms = ?");
  params.push(Date.now());
  getDb()
    .prepare(
      `UPDATE initiatives SET ${sets.join(", ")} WHERE id = ? AND deleted_at_ms IS NULL`,
    )
    .run(...params, id);
  touch.add(id);
}

function setArchived(touch: Set<number>, id: number, archived: boolean): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE initiatives SET archived_at_ms = ?, updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
    )
    .run(archived ? now : null, now, id);
  touch.add(id);
}

/** Tombstone the row and drop its membership edges. */
function remove(touch: Set<number>, id: number): void {
  getDb()
    .prepare(
      "UPDATE initiatives SET deleted_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
    )
    .run(Date.now(), id);
  removeAllFor(initiativeNode(id));
  touch.add(id);
}

/* ------------------------------ membership ------------------------------- */

/** The stored membership edges, in the user's order. */
function memberEdges(id: number): InitiativeMemberEdge[] {
  return outgoing(initiativeNode(id), "member")
    .filter((edge) => edge.toType === "task")
    .map((edge, index) => ({
      taskId: Number(edge.toId),
      position: edge.position ?? index,
      milestone:
        (edge.metadata as { milestone?: unknown } | undefined)?.milestone ===
        true,
    }));
}

/** A Task's ancestors, parent first; a stored hierarchy cycle stops the walk. */
function ancestorIds(taskId: number): number[] {
  const chain: number[] = [];
  const seen = new Set([taskId]);
  let cursor = parentOf(taskId);
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = parentOf(cursor);
  }
  return chain;
}

function parentOf(taskId: number): number | undefined {
  const edge = incoming(taskNode(taskId), "subtask").find(
    (link) => link.fromType === "task",
  );
  return edge ? Number(edge.fromId) : undefined;
}

/** Store a membership edge, plain or marked, after the last one unless placed. */
function addMember(
  touch: Set<number>,
  id: number,
  taskId: number,
  milestone = false,
  at?: number,
): void {
  const edges = memberEdges(id);
  const position =
    at ??
    (edges.length ? Math.max(...edges.map((edge) => edge.position)) + 1 : 0);
  addLink(initiativeNode(id), "member", taskNode(taskId), {
    position,
    ...(milestone ? { metadata: { milestone: true } } : {}),
  });
  touch.add(id);
}

function removeMember(touch: Set<number>, id: number, taskId: number): void {
  removeLink(initiativeNode(id), "member", taskNode(taskId));
  touch.add(id);
}

/** Rewrite one stored edge's milestone mark, keeping its position. */
function setMilestone(
  touch: Set<number>,
  id: number,
  edge: InitiativeMemberEdge,
  milestone: boolean,
): void {
  addLink(initiativeNode(id), "member", taskNode(edge.taskId), {
    position: edge.position,
    ...(milestone ? { metadata: { milestone: true } } : {}),
  });
  touch.add(id);
}

/**
 * Drop every PLAIN edge another stored edge of the same Initiative now covers,
 * and answer the Task ids it dropped. A covered Task is a member through its
 * ancestor, so this changes what is stored, never who is a member. Marked
 * edges stay: they carry a milestone.
 *
 * Runs inside the caller's transaction and stamps nothing itself: a Task move
 * that nests a member reports the Initiatives holding it through the Task
 * notification seam right after it commits, and an Initiative write has its
 * own mutation.
 */
function dropCoveredPlainEdges(id: number): number[] {
  const edges = memberEdges(id);
  const stored = new Set(edges.map((edge) => edge.taskId));
  const dropped: number[] = [];
  for (const edge of edges) {
    if (edge.milestone) continue;
    if (!ancestorIds(edge.taskId).some((ancestor) => stored.has(ancestor)))
      continue;
    removeLink(initiativeNode(id), "member", taskNode(edge.taskId));
    dropped.push(edge.taskId);
  }
  return dropped;
}

/**
 * Stored members plus every descendant, walked along `subtask` edges. `UNION`
 * deduplicates, so a member under another member and a stored hierarchy cycle
 * both terminate.
 *
 * Every walk here joins `CROSS JOIN`: SQLite then keeps the written order, the
 * few ids already found driving an index search of `links`. A lookup by the
 * edge's TARGET names `links_to_idx`: given `from_type` as well, the planner
 * otherwise prefers the covering primary key on `from_type` alone, which is
 * every edge leaving a Task (`initiativeStoreQueryPlan.test.ts`).
 */
const MEMBERS_CTE = `WITH RECURSIVE member(id) AS (
    SELECT to_id FROM links
     WHERE from_type = 'initiative' AND from_id = ? AND relation = 'member' AND to_type = 'task'
    UNION
    SELECT l.to_id FROM member m CROSS JOIN links l
        ON l.from_type = 'task' AND l.from_id = m.id AND l.relation = 'subtask' AND l.to_type = 'task'
  )`;

/** Exposed for the query-plan test: what the summary and graph reads issue. */
export const INITIATIVE_STORE_SQL = {
  members: `${MEMBERS_CTE}
    SELECT t.id, t.title, t.status, t.sort_order, t.archived_at_ms,
           (SELECT p.from_id FROM links p INDEXED BY links_to_idx
             WHERE p.to_type = 'task' AND p.to_id = m.id AND p.relation = 'subtask' AND p.from_type = 'task'
             LIMIT 1) AS parent_id,
           (SELECT j.to_id FROM links j
             WHERE j.from_type = 'task' AND j.from_id = m.id AND j.relation = 'in_project'
             LIMIT 1) AS project_id,
           (SELECT COUNT(*) FROM links b INDEXED BY links_to_idx CROSS JOIN tasks bt ON bt.id = CAST(b.from_id AS INTEGER)
             WHERE b.to_type = 'task' AND b.to_id = m.id AND b.relation = 'blocks' AND b.from_type = 'task'
               AND bt.deleted_at_ms IS NULL AND bt.archived_at_ms IS NULL AND bt.status <> 'done') AS open_blockers
      FROM member m CROSS JOIN tasks t ON t.id = CAST(m.id AS INTEGER)
     WHERE t.deleted_at_ms IS NULL`,
  /**
   * The LIVE sessions on member Tasks, archived Tasks included: a user-scope
   * session row (default-closed: a link to a session with no row, or another
   * scope, never qualifies) that is neither tombstoned, archived nor settled —
   * the `sessionStore.isSettled` conjunction, so a raised outcome counts again.
   * Each linked session is one primary-key lookup; nothing reads session
   * history beyond the member Tasks' own links.
   */
  memberSessions: `${MEMBERS_CTE}
    SELECT DISTINCT s.id AS session_id, s.created_at_ms
      FROM member m
      CROSS JOIN tasks t ON t.id = CAST(m.id AS INTEGER)
      CROSS JOIN links l ON l.from_type = 'task' AND l.from_id = m.id AND l.relation = 'context' AND l.to_type = 'session'
      CROSS JOIN session_index s ON s.id = l.to_id
     WHERE t.deleted_at_ms IS NULL
       AND s.scope = 'user' AND s.deleted_at_ms IS NULL AND s.archived_at_ms IS NULL
       AND (s.settled_at_ms IS NULL OR s.attention_revision > s.attention_settled_revision)
     ORDER BY s.created_at_ms DESC, s.id`,
  blockersInto: `SELECT b.from_id, b.to_id, t.title, t.status, t.archived_at_ms,
           (SELECT j.to_id FROM links j
             WHERE j.from_type = 'task' AND j.from_id = b.from_id AND j.relation = 'in_project'
             LIMIT 1) AS project_id
      FROM links b INDEXED BY links_to_idx
      CROSS JOIN tasks t ON t.id = CAST(b.from_id AS INTEGER)
     WHERE b.to_type = 'task' AND b.to_id IN (SELECT value FROM json_each(?))
       AND b.relation = 'blocks' AND b.from_type = 'task'
       AND t.deleted_at_ms IS NULL
     ORDER BY b.created_at_ms`,
  /**
   * The Initiatives that read any of the given Tasks: a Task is read by the
   * Initiatives holding it (as a member or through a member ancestor) and, as
   * an external blocker stub, by the ones holding a Task it blocks. So the walk
   * seeds with the Tasks and the Tasks they block, goes UP `subtask` edges, then
   * across to `member` edges. Runs on every Task write, so it touches only
   * index entries of those Tasks and their ancestor chains.
   */
  holders: `WITH RECURSIVE lineage(id) AS (
      SELECT value FROM json_each(?)
      UNION
      SELECT b.to_id FROM json_each(?) seed CROSS JOIN links b
          ON b.from_type = 'task' AND b.from_id = seed.value AND b.relation = 'blocks' AND b.to_type = 'task'
      UNION
      SELECT l.from_id FROM lineage a CROSS JOIN links l INDEXED BY links_to_idx
          ON l.to_type = 'task' AND l.to_id = a.id AND l.relation = 'subtask' AND l.from_type = 'task'
    )
    SELECT DISTINCT l.from_id AS id FROM lineage a CROSS JOIN links l INDEXED BY links_to_idx
        ON l.to_type = 'task' AND l.to_id = a.id AND l.relation = 'member' AND l.from_type = 'initiative'`,
  /** The Tasks linked to the given sessions: where a session change lands. */
  sessionTasks: `SELECT DISTINCT l.from_id AS id
      FROM links l INDEXED BY links_to_idx
     WHERE l.to_type = 'session' AND l.to_id IN (SELECT value FROM json_each(?))
       AND l.relation = 'context' AND l.from_type = 'task'`,
} as const;

function members(id: number): InitiativeMemberRow[] {
  const rows = getDb()
    .prepare(INITIATIVE_STORE_SQL.members)
    .all(String(id)) as unknown as Array<{
    id: number;
    title: string;
    status: TaskStatus;
    sort_order: number | null;
    archived_at_ms: number | null;
    parent_id: string | null;
    project_id: string | null;
    open_blockers: number;
  }>;
  return rows.map((row) => ({
    taskId: row.id,
    title: row.title,
    status: row.status,
    ...(row.sort_order !== null ? { sortOrder: row.sort_order } : {}),
    archived: row.archived_at_ms !== null,
    ...(row.parent_id !== null ? { parentId: Number(row.parent_id) } : {}),
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    openBlockers: row.open_blockers,
  }));
}

/** The live sessions on member Tasks, newest first. */
function memberSessionIds(id: number): string[] {
  const rows = getDb()
    .prepare(INITIATIVE_STORE_SQL.memberSessions)
    .all(String(id)) as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

/** Every `blocks` link into the given Tasks from a live Task. */
function blockersInto(taskIds: readonly number[]): InitiativeBlockerEdge[] {
  if (!taskIds.length) return [];
  const rows = getDb()
    .prepare(INITIATIVE_STORE_SQL.blockersInto)
    .all(JSON.stringify(taskIds.map(String))) as unknown as Array<{
    from_id: string;
    to_id: string;
    title: string;
    status: TaskStatus;
    archived_at_ms: number | null;
    project_id: string | null;
  }>;
  return rows.map((row) => ({
    fromId: Number(row.from_id),
    toId: Number(row.to_id),
    title: row.title,
    status: row.status,
    archived: row.archived_at_ms !== null,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
  }));
}

/** The Initiatives that read any of `taskIds` (see `INITIATIVE_STORE_SQL.holders`). */
function holdersOf(taskIds: Iterable<number>): number[] {
  const ids = JSON.stringify([...new Set(taskIds)].map(String));
  if (ids === "[]") return [];
  const rows = getDb()
    .prepare(INITIATIVE_STORE_SQL.holders)
    .all(ids, ids) as Array<{ id: string }>;
  return rows.map((row) => Number(row.id));
}

/**
 * The Task notification seam's fan-out: bump and notify every Initiative that
 * reads one of `taskIds` now, plus `formerHolders` — the ones a delete or a
 * move took the Task away from, read before the write.
 */
function touchHolders(
  taskIds: Iterable<number>,
  formerHolders: Iterable<number> = [],
): void {
  const ids = new Set([...holdersOf(taskIds), ...formerHolders]);
  if (!ids.size) return;
  mutation((touch) => {
    for (const id of ids) touch.add(id);
  });
}

/**
 * A session's liveness changed, so the summaries listing the sessions of the
 * Tasks it is linked to may have to add or drop it.
 */
function touchSessionHolders(sessionIds: readonly string[]): void {
  if (!sessionIds.length) return;
  const rows = getDb()
    .prepare(INITIATIVE_STORE_SQL.sessionTasks)
    .all(JSON.stringify([...new Set(sessionIds)])) as Array<{ id: string }>;
  touchHolders(rows.map((row) => Number(row.id)));
}

sessionStore.subscribeLiveness((ids) => {
  try {
    touchSessionHolders(ids);
  } catch (error) {
    // The session write is durable already; say that the summaries listing
    // its sessions stay behind until their next write.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[initiatives] session fan-out failed: ${detail}`);
  }
});

/* ------------------------------- revisions -------------------------------- */

/** Every row's revision and live-projection membership (not archived, not tombstoned). */
function revisions(): Array<{ id: number; revision: number; live: boolean }> {
  const rows = getDb()
    .prepare(
      "SELECT id, revision, archived_at_ms, deleted_at_ms FROM initiatives",
    )
    .all() as Array<{
    id: number;
    revision: number;
    archived_at_ms: number | null;
    deleted_at_ms: number | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    live: row.archived_at_ms === null && row.deleted_at_ms === null,
  }));
}

/* --------------------------------- rows ---------------------------------- */

interface DbInitiativeRow {
  id: number;
  title: string;
  description: string;
  state: InitiativeState;
  revision: number;
  attention_revision: number;
  attention_settled_revision: number;
  attention_kind: Exclude<InitiativeState, "active"> | null;
  attention_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  archived_at_ms: number | null;
  deleted_at_ms: number | null;
}

function fromRow(row: DbInitiativeRow): InitiativeRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    state: row.state,
    revision: row.revision,
    attentionRevision: row.attention_revision,
    attentionSettledRevision: row.attention_settled_revision,
    ...(row.attention_kind !== null
      ? { attentionKind: row.attention_kind }
      : {}),
    ...(row.attention_at_ms !== null
      ? { attentionAt: row.attention_at_ms }
      : {}),
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.archived_at_ms !== null ? { archivedAt: row.archived_at_ms } : {}),
  };
}

export const initiativeStore = {
  mutation,
  subscribe,
  // rows
  create,
  get,
  list,
  update,
  setArchived,
  remove,
  // membership
  memberEdges,
  ancestorIds,
  addMember,
  removeMember,
  setMilestone,
  dropCoveredPlainEdges,
  members,
  memberSessionIds,
  blockersInto,
  holdersOf,
  touchHolders,
  // revisions
  revisions,
};
