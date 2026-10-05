/**
 * The `tasks` store (see docs/tasks/PLAN.md).
 *
 * One `Task` concept. The row holds only intrinsic attributes; every relationship
 * (hierarchy, project, session, jira, url) is an edge in the generic
 * {@link ./links.ts} graph. Integer ids are allocated per type from
 * {@link ./sequences.ts} and surface as `Task-<n>`.
 *
 * Writes are synchronous (node:sqlite + WAL), durable at call time; `closeDb()`
 * flushes on exit. This is the single façade over task metadata.
 */
import { getDb } from "./index.ts";
import { nextId } from "./sequences.ts";
import {
  addLink,
  incoming,
  outgoing,
  removeAllFor,
  removeLink,
  setOutgoing,
  type Link,
  type NodeRef,
} from "./links.ts";

type TaskStatus = "todo" | "doing" | "done";
type TaskPriority = "low" | "normal" | "high" | "urgent";
type TaskCreatedBy = "user" | "agent";

interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  dueDate?: string;
  /** When the user plans to WORK on this, 'YYYY-MM-DD'. Not a deadline. */
  scheduledFor?: string;
  /** When the user processed this Task; unset means it is still in the Inbox. */
  triagedAt?: number;
  /** Which persona created this Task, when an agent did. */
  sourceAgentType?: string;
  /** The session that created it, for tracing an arrival back to its run. */
  sourceSessionId?: string;
  /** The status an agent suggests, pending the user's answer ('done'|'todo'). */
  statusSuggestionTo?: TaskStatus;
  /** When that suggestion was made. */
  statusSuggestionAt?: number;
  /** The agent session that made it. */
  statusSuggestionBy?: string;
  /** One short line saying why. */
  statusSuggestionReason?: string;
  createdBy: TaskCreatedBy;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  archivedAt?: number;
  commitHash?: string;
  committedAt?: number;
  /** Manual ordering position (root + siblings); assigned by drag-reorder. */
  sortOrder?: number;
  /**
   * Monotonic per-row state-event revision, stamped by {@link stampRevisions}
   * when a write notifies. Never travels as a field on a wire object — it rides
   * the event envelope (docs/state-sync.md).
   */
  revision: number;
}

interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string;
  scheduledFor?: string;
  triagedAt?: number;
  sourceAgentType?: string;
  sourceSessionId?: string;
  createdBy?: TaskCreatedBy;
}

interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  scheduledFor?: string | null;
  triagedAt?: number | null;
  statusSuggestionTo?: TaskStatus | null;
  statusSuggestionAt?: number | null;
  statusSuggestionBy?: string | null;
  statusSuggestionReason?: string | null;
  commitHash?: string | null;
  committedAt?: number | null;
  sortOrder?: number | null;
}

interface TaskListFilter {
  status?: TaskStatus;
  includeArchived?: boolean;
}

/** Display id, e.g. `Task-42`. */
function displayId(id: number): string {
  return `Task-${id}`;
}

/** The graph node for a task. */
function taskNode(id: number): NodeRef {
  return { type: "task", id: String(id) };
}

/* --------------------------------- CRUD ---------------------------------- */

function create(input: CreateTaskInput): Task {
  const db = getDb();
  const now = Date.now();
  const status = input.status ?? "todo";
  db.exec("BEGIN");
  try {
    const id = nextId("task");
    db.prepare(
      `
      INSERT INTO tasks (id, title, status, priority, description, due_date, scheduled_for, triaged_at_ms, source_agent_type, source_session_id, created_by, created_at_ms, updated_at_ms, completed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      input.title,
      status,
      input.priority ?? "normal",
      input.description ?? "",
      input.dueDate ?? null,
      input.scheduledFor ?? null,
      input.triagedAt ?? null,
      input.sourceAgentType ?? null,
      input.sourceSessionId ?? null,
      input.createdBy ?? "agent",
      now,
      now,
      status === "done" ? now : null,
    );
    db.exec("COMMIT");
    return get(id)!;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function get(id: number): Task | undefined {
  const row = getDb()
    .prepare("SELECT * FROM tasks WHERE id = ? AND deleted_at_ms IS NULL")
    .get(id) as DbTaskRow | undefined;
  return row ? fromRow(row) : undefined;
}

function list(filter: TaskListFilter = {}): Task[] {
  const clauses = ["deleted_at_ms IS NULL"];
  const params: unknown[] = [];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (!filter.includeArchived) clauses.push("archived_at_ms IS NULL");
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY updated_at_ms DESC`,
    )
    .all(...(params as never[])) as unknown as DbTaskRow[];
  return rows.map(fromRow);
}

/** Case-insensitive substring search over title + description. */
function search(query: string): Task[] {
  const q = `%${query.trim().toLowerCase()}%`;
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM tasks
      WHERE deleted_at_ms IS NULL
        AND (lower(title) LIKE ? OR lower(description) LIKE ?)
      ORDER BY updated_at_ms DESC
    `,
    )
    .all(q, q) as unknown as DbTaskRow[];
  return rows.map(fromRow);
}

function update(id: number, patch: UpdateTaskInput): Task | undefined {
  const current = get(id);
  if (!current) return undefined;
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    params.push(value);
  };
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.priority !== undefined) set("priority", patch.priority);
  if (patch.dueDate !== undefined) set("due_date", patch.dueDate);
  if (patch.scheduledFor !== undefined)
    set("scheduled_for", patch.scheduledFor);
  if (patch.triagedAt !== undefined) set("triaged_at_ms", patch.triagedAt);
  if (patch.statusSuggestionTo !== undefined)
    set("status_suggestion_to", patch.statusSuggestionTo);
  if (patch.statusSuggestionAt !== undefined)
    set("status_suggestion_at_ms", patch.statusSuggestionAt);
  if (patch.statusSuggestionBy !== undefined)
    set("status_suggestion_by", patch.statusSuggestionBy);
  if (patch.statusSuggestionReason !== undefined)
    set("status_suggestion_reason", patch.statusSuggestionReason);
  if (patch.commitHash !== undefined) set("commit_hash", patch.commitHash);
  if (patch.committedAt !== undefined)
    set("committed_at_ms", patch.committedAt);
  if (patch.sortOrder !== undefined) set("sort_order", patch.sortOrder);
  if (patch.status !== undefined) {
    set("status", patch.status);
    // completed_at is set on the first transition into done, cleared when leaving.
    if (patch.status === "done")
      set("completed_at_ms", current.completedAt ?? Date.now());
    else set("completed_at_ms", null);
  }
  set("updated_at_ms", Date.now());
  getDb()
    .prepare(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND deleted_at_ms IS NULL`,
    )
    .run(...(params as never[]), id);
  return get(id);
}

function setStatus(id: number, status: TaskStatus): Task | undefined {
  return update(id, { status });
}

/* -------------------------- status provenance ---------------------------- */

/** Who performed a Task status change. */
export interface TaskStatusActor {
  kind: "user" | "agent" | "system";
  /** Session id for agents, subsystem name for system actors. */
  id?: string;
}

interface TaskStatusEvent {
  id: number;
  taskId: number;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  actorKind: TaskStatusActor["kind"];
  actorId: string | null;
  atMs: number;
}

function addStatusEvent(
  taskId: number,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  actor: TaskStatusActor,
  atMs = Date.now(),
): void {
  getDb()
    .prepare(
      "INSERT INTO task_status_events (task_id, from_status, to_status, actor_kind, actor_id, at_ms) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(taskId, fromStatus, toStatus, actor.kind, actor.id ?? null, atMs);
}

type StatusEventRow = {
  id: number;
  task_id: number;
  from_status: TaskStatus;
  to_status: TaskStatus;
  actor_kind: TaskStatusActor["kind"];
  actor_id: string | null;
  at_ms: number;
};

function statusEventFromRow(row: StatusEventRow): TaskStatusEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    atMs: row.at_ms,
  };
}

/** All status events for one Task, oldest first. */
function statusEventsForTask(taskId: number): TaskStatusEvent[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM task_status_events WHERE task_id = ? ORDER BY at_ms ASC",
    )
    .all(taskId) as unknown as StatusEventRow[];
  return rows.map(statusEventFromRow);
}

function setArchived(id: number, archived: boolean): void {
  getDb()
    .prepare(
      "UPDATE tasks SET archived_at_ms = ?, updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
    )
    .run(archived ? Date.now() : null, Date.now(), id);
}

/* ------------------------------- revisions -------------------------------- */

/** One row's state-event revision and whether it is in the live projection. */
interface TaskRevisionRow {
  id: number;
  revision: number;
  /** In the canonical live projection: neither archived nor tombstoned. */
  live: boolean;
}

/**
 * Stamp `ids` with the next value of the persisted `task_revision` sequence and
 * return it. One value for the whole batch: revisions only ever need to be
 * monotonic PER ROW, and a shared value keeps a sweep that archives fifty Tasks
 * to a single sequence allocation.
 *
 * Tombstoned rows are stamped too — a delete event carries a revision, and the
 * row survives the tombstone.
 */
function stampRevisions(ids: readonly number[]): number {
  const db = getDb();
  const revision = nextId("task_revision");
  db.exec("BEGIN");
  try {
    const update = db.prepare("UPDATE tasks SET revision = ? WHERE id = ?");
    for (const id of ids) update.run(revision, id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return revision;
}

/**
 * Every Task's revision and live-projection membership, in one read.
 *
 * The broadcast flush diffs this against the map it last sent, so it needs the
 * ARCHIVED and tombstoned rows as well: they are what turns into a delete event.
 */
function revisions(): TaskRevisionRow[] {
  const rows = getDb()
    .prepare("SELECT id, revision, archived_at_ms, deleted_at_ms FROM tasks")
    .all() as unknown as Array<{
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

/** Tombstone a task and remove all its graph edges. */
function remove(id: number, ts = Date.now()): void {
  getDb()
    .prepare(
      "UPDATE tasks SET deleted_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
    )
    .run(ts, id);
  removeAllFor(taskNode(id));
}

/* ------------------------------- hierarchy ------------------------------- */

/** Ordered child tasks of a parent. */
function children(parentId: number): Task[] {
  return outgoing(taskNode(parentId), "subtask")
    .map((edge) => get(Number(edge.toId)))
    .filter((t): t is Task => Boolean(t));
}

/**
 * The manual position a Task takes when it JOINS a sibling group and nobody
 * stated one — a create, a reparent, a Task coming back from the archive.
 *
 * Every Task carries a position from birth, so the Backlog never has to infer
 * one from a mutable field: a row with no `sortOrder` used to fall back to
 * recency, which moved it whenever the Task was touched.
 *
 * The two groups want opposite ends. A Task joining the ROOT is an arrival that
 * has to be SEEN, so it goes above everything — strictly below the smallest
 * position in the table, which can never collide with a live row or with an
 * archived one still holding the index it had before. A Task joining a PARENT
 * is part of that parent's plan, and a plan reads top-down, so it is appended
 * after its siblings (archived ones included, so a return from the archive
 * cannot land on a taken index).
 */
function nextSortOrder(parentId: number | null): number {
  if (parentId === null) {
    const row = getDb()
      .prepare(
        "SELECT MIN(sort_order) AS lowest FROM tasks WHERE deleted_at_ms IS NULL",
      )
      .get() as { lowest: number | null } | undefined;
    return (row?.lowest ?? 1) - 1;
  }
  const taken = children(parentId)
    .map((child) => child.sortOrder)
    .filter((order): order is number => order !== undefined);
  return taken.length ? Math.max(...taken) + 1 : 0;
}

/** The parent task id of a child, if any. */
function parentOf(childId: number): number | undefined {
  const edge = incoming(taskNode(childId), "subtask")[0];
  return edge ? Number(edge.fromId) : undefined;
}

/**
 * Set (or clear, with `parentId === null`) a task's parent. Enforces a tree:
 * at most one parent, no self-parenting, no cycles. `position` orders the child
 * among its siblings.
 *
 * A subtask lives in its parent's project, so a MOVE under a parent that has
 * one pulls the moved node and its whole subtree in (see {@link setProject}).
 * This is the one seam every write path shares — agent create, UI save, an
 * update that reparents, and the Backlog drag, which never touches
 * `applyRelations` at all.
 *
 * Two cases deliberately inherit nothing. Reparenting to the root, or under a
 * parent with no project, LEAVES the project alone rather than destroying
 * information; and re-stating the same parent (an ordinary save, a sibling
 * reorder) is not a move, so a deliberately unset subtask stays unset.
 *
 * Returns the OTHER task ids this write changed (the inherited-project
 * subtree), so the caller can report them through the change-notification seam:
 * their list rows moved, and an unreported row would never be broadcast.
 */
function setParent(
  childId: number,
  parentId: number | null,
  position?: number,
): number[] {
  const previousParent = parentOf(childId);
  // Drop any existing parent edge (single-parent invariant).
  for (const edge of incoming(taskNode(childId), "subtask")) {
    removeLink({ type: "task", id: edge.fromId }, "subtask", taskNode(childId));
  }
  if (parentId === null) return [];
  if (parentId === childId) throw new Error("A task cannot be its own parent.");
  if (!get(parentId)) throw new Error(`Parent task not found: ${parentId}`);
  // Acyclic: childId must not be an ancestor of parentId.
  let cursor: number | undefined = parentId;
  const seen = new Set<number>();
  while (cursor !== undefined) {
    if (cursor === childId)
      throw new Error("Task hierarchy cannot contain a cycle.");
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = parentOf(cursor);
  }
  const pos = position ?? children(parentId).length;
  addLink(taskNode(parentId), "subtask", taskNode(childId), { position: pos });
  if (parentId === previousParent) return [];
  const inherited = projectOf(parentId);
  return inherited ? setProject(childId, inherited) : [];
}

/* ------------------------------- relations ------------------------------- */

/**
 * Set (or clear) the task's project (single project).
 *
 * Assigning CASCADES down the subtask tree: a project is a property of the
 * piece of work, not of one node of it, so fixing an epic fixes its tree. The
 * cascade never runs upward — a project on one subtask says nothing about its
 * epic or its siblings.
 *
 * Clearing does not cascade. It is the explicit escape hatch for one node, and
 * a clear that wiped a whole subtree would destroy information the user never
 * asked to lose. A later assignment on an ancestor still re-fills the cleared
 * node: the cascade runs whether or not this node already matches, so a repair
 * reaches a mismatch deeper down instead of stopping above it.
 *
 * Returns every task id whose project edge actually moved — the cascade is a
 * write to a whole subtree, and each of those rows owes its viewers an event.
 */
function setProject(taskId: number, projectId: string | null): number[] {
  if (projectId === null) {
    setOutgoing(taskNode(taskId), "in_project", []);
    return [taskId];
  }
  // Stored hierarchy may already hold a cycle — `setParent` tolerates a
  // pre-existing one rather than throwing — so the cascade carries a visited
  // set instead of recursing until the stack blows on an ordinary assignment.
  const seen = new Set<number>();
  const changed: number[] = [];
  const assign = (id: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (projectOf(id) !== projectId) {
      setOutgoing(taskNode(id), "in_project", [
        { to: { type: "project", id: projectId } },
      ]);
      changed.push(id);
    }
    for (const child of children(id)) assign(child.id);
  };
  assign(taskId);
  return changed;
}

function projectOf(taskId: number): string | undefined {
  return outgoing(taskNode(taskId), "in_project")[0]?.toId;
}

/** Link a task to a session as context (auto-linked when created inside a session). */
function linkSession(taskId: number, sessionId: string): void {
  addLink(taskNode(taskId), "context", { type: "session", id: sessionId });
}

function sessionsFor(taskId: number): string[] {
  return outgoing(taskNode(taskId), "context").map((e) => e.toId);
}

/**
 * The status of every listed (unarchived, undeleted) Task on each of its
 * `context` session edges, in one join: the session list's per-session Task
 * progress. It is re-read after every Task write, and assembling full Task
 * summaries only to count statuses cost ~40 ms on a production copy.
 */
function sessionTaskStatuses(): Array<{
  sessionId: string;
  status: TaskStatus;
}> {
  return getDb()
    .prepare(
      `SELECT l.to_id AS sessionId, t.status AS status
         FROM links l JOIN tasks t ON t.id = l.from_id
        WHERE l.from_type = 'task' AND l.relation = 'context'
          AND t.deleted_at_ms IS NULL AND t.archived_at_ms IS NULL`,
    )
    .all() as Array<{ sessionId: string; status: TaskStatus }>;
}

/** Replace the task's Jira issue links. */
function setJira(taskId: number, issueKeys: string[]): void {
  setOutgoing(
    taskNode(taskId),
    "jira",
    issueKeys.map((key) => ({ to: { type: "jira", id: key } })),
  );
}

function jiraFor(taskId: number): string[] {
  return outgoing(taskNode(taskId), "jira").map((e) => e.toId);
}

/** Replace the task's GitHub issue links (canonical `owner/repo#123` refs). */
function setGithubIssues(taskId: number, refs: string[]): void {
  setOutgoing(
    taskNode(taskId),
    "github",
    refs.map((ref) => ({ to: { type: "github", id: ref } })),
  );
}

/** Add an external URL link (source/related in metadata). */
function addUrl(
  taskId: number,
  url: string,
  kind: "source" | "related" = "source",
): void {
  addLink(
    taskNode(taskId),
    "link",
    { type: "url", id: url },
    { metadata: { kind } },
  );
}

function urlsFor(taskId: number): Array<{ url: string; kind: string }> {
  return outgoing(taskNode(taskId), "link").map((e) => ({
    url: e.toId,
    kind: (e.metadata as { kind?: string } | undefined)?.kind ?? "source",
  }));
}

/** All edges touching a task (both directions), for detail views. */
function links(taskId: number): { outgoing: Link[]; incoming: Link[] } {
  return {
    outgoing: outgoing(taskNode(taskId)),
    incoming: incoming(taskNode(taskId)),
  };
}

/* --------------------------------- rows ---------------------------------- */

interface DbTaskRow {
  id: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  due_date: string | null;
  scheduled_for: string | null;
  triaged_at_ms: number | null;
  source_agent_type: string | null;
  source_session_id: string | null;
  status_suggestion_to: TaskStatus | null;
  status_suggestion_at_ms: number | null;
  status_suggestion_by: string | null;
  status_suggestion_reason: string | null;
  created_by: TaskCreatedBy;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
  archived_at_ms: number | null;
  commit_hash: string | null;
  committed_at_ms: number | null;
  sort_order: number | null;
  deleted_at_ms: number | null;
  revision: number;
}

function fromRow(row: DbTaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    description: row.description,
    ...(row.due_date ? { dueDate: row.due_date } : {}),
    ...(row.scheduled_for ? { scheduledFor: row.scheduled_for } : {}),
    ...(row.triaged_at_ms !== null ? { triagedAt: row.triaged_at_ms } : {}),
    ...(row.source_agent_type
      ? { sourceAgentType: row.source_agent_type }
      : {}),
    ...(row.source_session_id
      ? { sourceSessionId: row.source_session_id }
      : {}),
    ...(row.status_suggestion_to
      ? { statusSuggestionTo: row.status_suggestion_to }
      : {}),
    ...(row.status_suggestion_at_ms !== null
      ? { statusSuggestionAt: row.status_suggestion_at_ms }
      : {}),
    ...(row.status_suggestion_by
      ? { statusSuggestionBy: row.status_suggestion_by }
      : {}),
    ...(row.status_suggestion_reason
      ? { statusSuggestionReason: row.status_suggestion_reason }
      : {}),
    createdBy: row.created_by,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.completed_at_ms !== null
      ? { completedAt: row.completed_at_ms }
      : {}),
    ...(row.archived_at_ms !== null ? { archivedAt: row.archived_at_ms } : {}),
    ...(row.commit_hash ? { commitHash: row.commit_hash } : {}),
    ...(row.committed_at_ms !== null
      ? { committedAt: row.committed_at_ms }
      : {}),
    ...(row.sort_order !== null ? { sortOrder: row.sort_order } : {}),
    revision: row.revision,
  };
}

export const taskStore = {
  create,
  get,
  list,
  search,
  update,
  setStatus,
  setArchived,
  remove,
  // state-event revisions
  stampRevisions,
  revisions,
  // status provenance
  addStatusEvent,
  statusEventsForTask,
  // hierarchy
  children,
  parentOf,
  setParent,
  nextSortOrder,
  // relations
  setProject,
  projectOf,
  linkSession,
  sessionsFor,
  sessionTaskStatuses,
  setJira,
  setGithubIssues,
  jiraFor,
  addUrl,
  urlsFor,
  links,
  // helpers
  displayId,
  taskNode,
};
