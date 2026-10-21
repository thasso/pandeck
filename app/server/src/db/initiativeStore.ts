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
import { getDb, inDbTransaction, withDbTransaction } from "./index.ts";
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
 * Run one Initiative write in its OWN transaction, stamp every Initiative it
 * touched with the next `initiative_revision` value before COMMIT, and notify
 * after it. A write that throws notifies nobody.
 *
 * Top-level only, like `createTask`: joined to a caller's transaction, a
 * failure the caller catches would leave half an operation in that commit with
 * no revision and no event. Refused before anything is written.
 */
function mutation<T>(fn: (touch: Set<number>) => T): T {
  if (getDb().isTransaction)
    throw new Error(
      "An Initiative write must not run inside an open database transaction.",
    );
  const { value, touched } = withDbTransaction(() => {
    const touched = new Set<number>();
    const value = fn(touched);
    stampRevisions(touched);
    return { value, touched };
  });
  notifyListeners(touched);
  return value;
}

/**
 * Bump and notify Initiatives whose summaries another domain's write changed.
 * The ONE stamp that may join a caller's open transaction: a session tombstone
 * inside a larger delete (`backgroundWorkStore.deleteOwnerSession`) moves the
 * Initiatives listing that session, and a rollback must take the stamp with
 * it. It only stamps — it writes nothing a caller could half-commit — and the
 * listeners only schedule a debounced flush that reads committed state.
 */
function stampAndNotify(ids: ReadonlySet<number>): void {
  if (!ids.size) return;
  inDbTransaction(() => stampRevisions(ids));
  notifyListeners(ids);
}

function stampRevisions(ids: ReadonlySet<number>): void {
  if (!ids.size) return;
  const revision = nextId("initiative_revision");
  const stamp = getDb().prepare(
    "UPDATE initiatives SET revision = ? WHERE id = ?",
  );
  for (const id of ids) stamp.run(revision, id);
}

function notifyListeners(ids: ReadonlySet<number>): void {
  if (!ids.size) return;
  const touched = [...ids].map(String);
  for (const listener of listeners) {
    try {
      listener(touched);
    } catch {
      // A listener cannot make an already durable write fail.
    }
  }
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
  const now = Date.now();
  if (patch.state !== undefined) {
    sets.push("state = ?");
    params.push(patch.state);
  }
  sets.push("updated_at_ms = ?");
  params.push(now);
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

/** Store a membership edge, plain or marked, after the last one. */
function addMember(
  touch: Set<number>,
  id: number,
  taskId: number,
  milestone = false,
): void {
  const edges = memberEdges(id);
  const position = edges.length
    ? Math.max(...edges.map((edge) => edge.position)) + 1
    : 0;
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

/**
 * Distinct live user sessions STARTED from a member Task, as CTE `live`: the
 * `context` edge `linkTaskStart` writes, `origin` `task-start` in its metadata.
 * A session that only referenced the Task, or whose link has no origin, is not
 * working on it (`docs/initiatives.md`). Both the page and the count read this
 * one CTE, so they cannot disagree on who qualifies.
 */
const LIVE_MEMBER_SESSIONS = `,
  live(id, created_at_ms) AS (
    SELECT DISTINCT s.id, s.created_at_ms
      FROM member m
      CROSS JOIN tasks t ON t.id = CAST(m.id AS INTEGER)
      CROSS JOIN links l ON l.from_type = 'task' AND l.from_id = m.id AND l.relation = 'context' AND l.to_type = 'session'
      CROSS JOIN session_index s ON s.id = l.to_id
     WHERE t.deleted_at_ms IS NULL
       AND CASE WHEN json_valid(l.metadata_json)
                THEN json_extract(l.metadata_json, '$.origin') END = 'task-start'
       AND s.scope = 'user' AND s.deleted_at_ms IS NULL AND s.archived_at_ms IS NULL
       AND (s.settled_at_ms IS NULL OR s.attention_revision > s.attention_settled_revision)
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
   * The LIVE sessions started from member Tasks, archived Tasks included
   * (`LIVE_MEMBER_SESSIONS`; a malformed edge metadata reads as no origin, never
   * as an error): a user-scope
   * session row (default-closed: a link to a session with no row, or another
   * scope, never qualifies) that is neither tombstoned, archived nor settled —
   * the `sessionStore.isSettled` conjunction, so a raised outcome counts again.
   * Each linked session is one primary-key lookup; nothing reads session
   * history beyond the member Tasks' own links. The page answers at most
   * `LIMIT` ids, newest session first by creation, ties by id; the count is
   * its own aggregate, so neither reaches JavaScript as a whole list.
   */
  memberSessions: `${MEMBERS_CTE}${LIVE_MEMBER_SESSIONS}
    SELECT id FROM live ORDER BY created_at_ms DESC, id LIMIT ?`,
  memberSessionCount: `${MEMBERS_CTE}${LIVE_MEMBER_SESSIONS}
    SELECT COUNT(*) AS n FROM live`,
  memberTaskStarts: `${MEMBERS_CTE}
    SELECT m.id AS task_id, s.id AS session_id
      FROM member m
      CROSS JOIN tasks t ON t.id = CAST(m.id AS INTEGER)
      CROSS JOIN links l ON l.from_type = 'task' AND l.from_id = m.id AND l.relation = 'context' AND l.to_type = 'session'
      CROSS JOIN session_index s ON s.id = l.to_id
     WHERE t.deleted_at_ms IS NULL AND s.scope = 'user' AND s.deleted_at_ms IS NULL
       AND CASE WHEN json_valid(l.metadata_json)
                THEN json_extract(l.metadata_json, '$.origin') END = 'task-start'`,
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
  /**
   * The live Initiatives holding each given Task: a member edge on the Task
   * itself or on an ancestor, walked UP `subtask` edges from each seed. Unlike
   * `holders`, nothing is seeded from the Tasks a seed blocks, so this is
   * membership and nothing more. `depth` is how far up the edge sits (0 for
   * the Task's own); a visited-id path stops stored hierarchy cycles without limiting legal depth.
   */
  memberships: `WITH RECURSIVE lineage(seed, id, depth, path) AS (
      SELECT value, value, 0, ',' || value || ',' FROM json_each(?)
      UNION ALL
      SELECT a.seed, l.from_id, a.depth + 1, a.path || l.from_id || ','
        FROM lineage a CROSS JOIN links l INDEXED BY links_to_idx
          ON l.to_type = 'task' AND l.to_id = a.id AND l.relation = 'subtask' AND l.from_type = 'task'
       WHERE instr(a.path, ',' || l.from_id || ',') = 0
    )
    SELECT a.seed, a.id AS task_id, a.depth, i.id, i.title, i.state,
           (SELECT t.title FROM tasks t WHERE t.id = CAST(a.id AS INTEGER)) AS task_title
      FROM lineage a CROSS JOIN links m INDEXED BY links_to_idx
          ON m.to_type = 'task' AND m.to_id = a.id AND m.relation = 'member' AND m.from_type = 'initiative'
      CROSS JOIN initiatives i ON i.id = CAST(m.from_id AS INTEGER)
     WHERE i.deleted_at_ms IS NULL AND i.archived_at_ms IS NULL
     ORDER BY a.seed, i.id, a.depth`,
  /** The given Tasks and every Task below them, walked DOWN `subtask` edges. */
  subtrees: `WITH RECURSIVE below(id) AS (
      SELECT value FROM json_each(?)
      UNION
      SELECT l.to_id FROM below d CROSS JOIN links l
          ON l.from_type = 'task' AND l.from_id = d.id AND l.relation = 'subtask' AND l.to_type = 'task'
    )
    SELECT id FROM below`,
  /** The Tasks linked to the given sessions: where a session change lands. */
  sessionTasks: `SELECT DISTINCT l.from_id AS id
      FROM links l INDEXED BY links_to_idx
     WHERE l.to_type = 'session' AND l.to_id IN (SELECT value FROM json_each(?))
       AND l.relation = 'context' AND l.from_type = 'task'`,
  /** The Initiatives the given sessions coordinate, for the liveness fan-out. */
  sessionCoordinated: `SELECT DISTINCT l.to_id AS id
      FROM links l INDEXED BY links_from_idx
     WHERE l.from_type = 'session' AND l.from_id IN (SELECT value FROM json_each(?))
       AND l.relation = 'coordinates' AND l.to_type = 'initiative'`,
  /**
   * The Initiative's recorded coordinators that are still live: a user-scope
   * session row neither tombstoned nor archived. Settled ones stay, since a
   * coordinator between turns is still the one driving it. Newest first.
   */
  coordinatorSessions: `SELECT s.id
      FROM links l INDEXED BY links_to_idx
      CROSS JOIN session_index s ON s.id = l.from_id
     WHERE l.to_type = 'initiative' AND l.to_id = ? AND l.relation = 'coordinates'
       AND l.from_type = 'session'
       AND s.scope = 'user' AND s.deleted_at_ms IS NULL AND s.archived_at_ms IS NULL
     ORDER BY s.created_at_ms DESC, s.id LIMIT ?`,
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

/** All user-scope Task-start roots, including archived and settled sessions. */
function memberTaskStarts(
  id: number,
): Array<{ taskId: string; sessionId: string }> {
  const rows = getDb()
    .prepare(INITIATIVE_STORE_SQL.memberTaskStarts)
    .all(String(id)) as Array<{ task_id: string; session_id: string }>;
  return rows.map((row) => ({
    taskId: row.task_id,
    sessionId: row.session_id,
  }));
}

/**
 * At most `limit` live sessions on member Tasks, newest first by creation
 * (ties by id), and how many there are in all.
 */
function memberSessions(
  id: number,
  limit: number,
): { ids: string[]; count: number } {
  const ids = (
    getDb()
      .prepare(INITIATIVE_STORE_SQL.memberSessions)
      .all(String(id), limit) as Array<{ id: string }>
  ).map((row) => row.id);
  const count = (
    getDb()
      .prepare(INITIATIVE_STORE_SQL.memberSessionCount)
      .get(String(id)) as {
      n: number;
    }
  ).n;
  return { ids, count };
}

/** The live coordinators of `id`, newest first, at most `limit`. */
function coordinatorSessions(id: number, limit: number): string[] {
  return (
    getDb()
      .prepare(INITIATIVE_STORE_SQL.coordinatorSessions)
      .all(String(id), limit) as Array<{ id: string }>
  ).map((row) => row.id);
}

/**
 * Record, or drop, that `sessionId` coordinates the Initiative. Idempotent:
 * an existing edge is kept, and a missing one is not an error to remove.
 */
function setCoordinator(
  touch: Set<number>,
  id: number,
  sessionId: string,
  coordinates: boolean,
): void {
  const session: NodeRef = { type: "session", id: sessionId };
  if (coordinates) addLink(session, "coordinates", initiativeNode(id));
  else removeLink(session, "coordinates", initiativeNode(id));
  touch.add(id);
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

/** A live Initiative holding a Task, and the nearest Task its edge is on. */
export interface InitiativeMembership {
  initiativeId: number;
  title: string;
  state: InitiativeState;
  /** The ancestor holding the member edge; absent when the Task holds its own. */
  through?: { taskId: number; title: string };
}

/**
 * The live Initiatives holding each of `taskIds`, directly or through an
 * ancestor (`INITIATIVE_STORE_SQL.memberships`), by Initiative id. When edges
 * sit at several levels — a milestone's own under a member epic — the nearest
 * one names the path, as `coveringEdge` judges it. A Task held by none has no
 * entry in the map.
 */
function membershipsOf(
  taskIds: Iterable<number>,
): Map<number, InitiativeMembership[]> {
  const result = new Map<number, InitiativeMembership[]>();
  const ids = JSON.stringify([...new Set(taskIds)].map(String));
  if (ids === "[]") return result;
  const rows = getDb()
    .prepare(INITIATIVE_STORE_SQL.memberships)
    .all(ids) as unknown as Array<{
    seed: string;
    task_id: string;
    depth: number;
    id: number;
    title: string;
    state: InitiativeState;
    task_title: string | null;
  }>;
  for (const row of rows) {
    const seed = Number(row.seed);
    const list = result.get(seed) ?? [];
    // Rows come nearest first per Initiative, so the first one names the path.
    if (list.some((entry) => entry.initiativeId === row.id)) continue;
    list.push({
      initiativeId: row.id,
      title: row.title,
      state: row.state,
      ...(row.depth > 0
        ? {
            through: {
              taskId: Number(row.task_id),
              title: row.task_title ?? "",
            },
          }
        : {}),
    });
    result.set(seed, list);
  }
  return result;
}

/** `roots` and every Task below them, archived ones included. */
function subtreeIds(roots: Iterable<number>): number[] {
  const ids = JSON.stringify([...new Set(roots)].map(String));
  if (ids === "[]") return [];
  return (
    getDb().prepare(INITIATIVE_STORE_SQL.subtrees).all(ids) as Array<{
      id: string;
    }>
  ).map((row) => Number(row.id));
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
  stampAndNotify(new Set([...holdersOf(taskIds), ...formerHolders]));
}

/**
 * A linked session changed: refresh the summaries listing it, through a member
 * Task it started from or as a coordinator.
 */
function touchSessionHolders(sessionIds: readonly string[]): void {
  if (!sessionIds.length) return;
  const ids = JSON.stringify([...new Set(sessionIds)]);
  const tasks = getDb()
    .prepare(INITIATIVE_STORE_SQL.sessionTasks)
    .all(ids) as Array<{ id: string }>;
  const coordinated = getDb()
    .prepare(INITIATIVE_STORE_SQL.sessionCoordinated)
    .all(ids) as Array<{ id: string }>;
  stampAndNotify(
    new Set([
      ...holdersOf(tasks.map((row) => Number(row.id))),
      ...coordinated.map((row) => Number(row.id)),
    ]),
  );
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
  memberSessions,
  memberTaskStarts,
  coordinatorSessions,
  setCoordinator,
  blockersInto,
  holdersOf,
  membershipsOf,
  subtreeIds,
  touchHolders,
  // revisions
  revisions,
};
