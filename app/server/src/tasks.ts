/**
 * Tasks — SQLite-backed (see docs/tasks/PLAN.md).
 *
 * This module exposes the current `TaskItem`/`TaskSummary` shape while the
 * storage is SQLite via {@link ./db/taskStore.ts} and the generic
 * {@link ./db/links.ts} graph:
 *   - intrinsic fields              → the `tasks` row
 *   - parent/project/session/jira/url → `links` edges
 *
 * The single-Task model has no session/global scope, no reminders, and no
 * task-dependencies. Ids surface as stringified integers ("42").
 */
import type {
  AgentType,
  Harness,
  StateDigestEntry,
  StateEvent,
  TaskBackRef,
  TaskExternalLink,
  TaskExternalLinkSource,
  TaskExternalLinkType,
  TaskItem,
  TaskPriority,
  TaskReorderPlacement,
  TaskSessionOrigin,
  TaskSessionRef,
  TaskStatus,
  TaskStatusSuggestion,
  TaskSummary,
} from "@assistant/shared";
import {
  isForgejoInstanceUrl,
  isTaskExternalLinkSource,
  normalizeGithubIssueRefs,
  taskSummaryOf,
} from "@assistant/shared";
import { taskStore, type TaskStatusActor } from "./db/taskStore.ts";
import {
  addLink,
  allLinks,
  incoming,
  outgoing,
  removeLink,
  type Link,
  type NodeRef,
} from "./db/links.ts";
import { getForgejoBaseUrl } from "./forgejoSettings.ts";
import { localDateOf } from "@assistant/shared/zonedTime";
import { userTimeZone } from "./userProfile.ts";

export interface TaskListFilter {
  status?: TaskStatus;
  projectId?: string;
  includeArchived?: boolean;
  priority?: TaskPriority;
  due?: "overdue" | "today" | "upcoming" | "unscheduled";
  scheduled?: "past" | "today" | "tomorrow" | "upcoming" | "unplanned";
  /** Only Tasks still waiting in the Inbox (never processed by the user). */
  untriaged?: boolean;
  session?: { kind: AgentType; sessionId: string };
  query?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  projectId?: string;
  jiraIssueKeys?: string[];
  githubIssues?: string[];
  externalLinks?: TaskExternalLink[];
  dueDate?: string;
  scheduledFor?: string;
  priority?: TaskPriority;
  sessionRefs?: TaskSessionRef[];
  parentId?: string;
  sortOrder?: number;
  /**
   * The Task was TYPED by the user rather than arriving, so it needs no triage.
   * Deliberately separate from `source.createdBy`, which records who wanted it:
   * a Slack shortcut import is created "by the user" and is still an arrival.
   */
  triaged?: boolean;
  source: TaskSummary["source"];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  projectId?: string | null;
  jiraIssueKeys?: string[];
  githubIssues?: string[];
  externalLinks?: TaskExternalLink[];
  dueDate?: string | null;
  scheduledFor?: string | null;
  priority?: TaskPriority | null;
  sessionRefs?: TaskSessionRef[];
  parentId?: string | null;
  sortOrder?: number | null;
  /** Dismiss a pending status suggestion without applying it. */
  clearStatusSuggestion?: boolean;
  /** One short line recorded with an agent's status suggestion. */
  statusReason?: string;
  /**
   * The USER asked for this status in this session, so an `agent` actor's
   * `done` is applied rather than only suggested. The suggestion is still
   * recorded, and the status event still says `agent`: the escape hatch is
   * explicit and stays visible and reversible, never silent.
   */
  userRequestedStatus?: boolean;
  /** Explicitly mark processed / put back in the Inbox. */
  triaged?: boolean;
  commitHash?: string | null;
  committedAt?: number | null;
  archivedAt?: number | null;
  /**
   * Who performs this mutation. Recorded as durable status-change provenance
   * when the patch changes `status`.
   * Defaults to a generic system actor when omitted.
   */
  actor?: TaskStatusActor;
}

/* ----------------------------- change events ----------------------------- */

let version = 1;
const listeners = new Set<TaskChangeListener>();
let autoArchiveSweepRunning = false;
let autoArchiveTimer: ReturnType<typeof setInterval> | undefined;

export const TASK_AUTO_ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const TASK_AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Receives the ids a write touched, already stamped with their new revisions. */
export type TaskChangeListener = (ids: readonly string[]) => void;

export function subscribeTaskChanges(fn: TaskChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Announce a Task write — and, in the SAME act, stamp the touched rows'
 * revisions (docs/state-sync.md).
 *
 * Notify-with-ids is deliberately the only way to bump a revision: a bump that
 * could happen without a notification (or a notification without a bump) is a
 * row whose viewers either never hear about the change or discard the event
 * that carries it. Every write path in this module therefore reports what it
 * touched, INCLUDING the rows a cascade moved (an inherited project) rather
 * than only the row the caller named.
 */
function notify(ids: Iterable<string>): void {
  // A write may make old completed work eligible (most importantly, completing
  // its active parent). Retention is best-effort: this write is already durable,
  // so a sweep failure must never make the caller see a false save failure or
  // suppress this write's version/broadcast. The hourly sweep retries later.
  if (!autoArchiveSweepRunning) runTaskAutoArchiveSweep("post-write");
  version += 1;
  const touched = [...new Set(ids)];
  const numeric = touched
    .map((id) => parseId(id))
    .filter((id): id is number => id !== undefined);
  if (numeric.length) taskStore.stampRevisions(numeric);
  for (const fn of listeners) {
    try {
      fn(touched);
    } catch {
      /* listener errors must not break writes */
    }
  }
}

/**
 * Public trigger for a task-list change originating outside this module (e.g. a
 * Project removal orphaning a Task's project link), so viewers see the change. The touched ids are required — they ARE the revision bump.
 */
export function notifyTaskChange(ids: Iterable<string>): void {
  notify(ids);
}

/**
 * Every Task's state-event revision and live-projection membership.
 *
 * The broadcast flush diffs this against the map it last sent; it deliberately
 * does NOT build the list, since the point of the event model is that only the
 * changed rows are ever projected and serialized.
 */
export function taskRevisionIndex(): Map<
  string,
  { revision: number; live: boolean }
> {
  const index = new Map<string, { revision: number; live: boolean }>();
  for (const row of taskStore.revisions())
    index.set(String(row.id), { revision: row.revision, live: row.live });
  return index;
}

/** The compact revision digest of exactly the canonical live projection. */
export function taskRevisionDigest(): StateDigestEntry[] {
  const entries: StateDigestEntry[] = [];
  for (const [id, entry] of taskRevisionIndex())
    if (entry.live) entries.push({ id, revision: entry.revision });
  return entries;
}

/**
 * Authoritative summaries for a digest diff, still expressed as ordinary state
 * events so targeted catch-up and live broadcasts share one apply seam.
 */
export function taskStateItems(
  ids: readonly string[],
): StateEvent<TaskSummary>[] {
  const index = taskRevisionIndex();
  const events: StateEvent<TaskSummary>[] = [];
  for (const id of new Set(ids)) {
    const entry = index.get(id);
    if (!entry) continue;
    if (!entry.live) {
      events.push({ kind: "delete", id, revision: entry.revision });
      continue;
    }
    const item = taskSummaryFor(id);
    if (item)
      events.push({ kind: "upsert", id, revision: entry.revision, item });
  }
  return events;
}

/**
 * The live-projection summary for one Task, or null when it is not in it
 * (archived, tombstoned, never existed) — which is exactly when the domain owes
 * its viewers a `delete` rather than an `upsert`.
 */
export function taskSummaryFor(id: string): TaskSummary | null {
  const nid = parseId(id);
  const item = nid === undefined ? null : readTask(id);
  if (!item || nid === undefined || item.archivedAt !== undefined) return null;
  return taskSummaryOf(item);
}

/** Sessions currently linked to a live Task, for the per-session back-link refresh. */
export function taskLinkedSessionIds(): Set<string> {
  const live = new Set<string>();
  for (const row of taskStore.revisions())
    if (row.live) live.add(String(row.id));
  const linked = new Set<string>();
  for (const link of allLinks()) {
    if (link.fromType !== "task" || link.relation !== "context") continue;
    if (live.has(link.fromId)) linked.add(link.toId);
  }
  return linked;
}

/**
 * Current Task-list version, for consumers that cache a derivation of the list.
 *
 * Deliberately NOT a snapshot with the items attached: the session list asks
 * this up to ~4 times a second only to find its cache still valid, and building
 * the list to answer that question cost ~12.6 ms against production data — the
 * single largest cost in a session-list rebuild. Callers read `listTasks()`
 * themselves on a miss.
 */
export function taskIndexVersion(): number {
  return version;
}

/* --------------------------------- ids ----------------------------------- */

const node = (id: number): NodeRef => ({ type: "task", id: String(id) });
const sessionNode = (id: string): NodeRef => ({ type: "session", id });

function parseId(id: string): number | undefined {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/* ------------------------------ list + read ------------------------------ */

export function listTasks(filter: TaskListFilter = {}): TaskSummary[] {
  const tasks = taskStore.list({
    ...(filter.includeArchived !== undefined
      ? { includeArchived: filter.includeArchived }
      : {}),
  });
  // Batch: one pass over all edges, assembled in memory.
  const links = allLinks();
  const outByTask = new Map<string, Link[]>();
  const parentByChild = new Map<string, Link>();
  for (const l of links) {
    if (l.fromType === "task") {
      const list = outByTask.get(l.fromId) ?? [];
      list.push(l);
      outByTask.set(l.fromId, list);
    }
    if (l.relation === "subtask") parentByChild.set(l.toId, l);
  }
  const query = filter.query?.trim().toLowerCase();
  const items = tasks
    .map((task) =>
      assemble(
        task,
        outByTask.get(String(task.id)) ?? [],
        parentByChild.get(String(task.id)),
      ),
    )
    .filter((item) => !filter.status || item.status === filter.status)
    .filter((item) => !filter.projectId || item.projectId === filter.projectId)
    .filter(
      (item) =>
        !filter.priority || (item.priority ?? "normal") === filter.priority,
    )
    .filter((item) => !filter.due || matchesDue(item, filter.due))
    .filter(
      (item) => !filter.scheduled || matchesScheduled(item, filter.scheduled),
    )
    .filter((item) => !filter.untriaged || item.triagedAt === undefined)
    .filter(
      (item) =>
        !filter.session ||
        (item.sessionRefs ?? []).some(
          (r) => r.sessionId === filter.session!.sessionId,
        ),
    )
    .filter((item) => !query || matchesQuery(item, query));

  return order(items).map(toSummary);
}

export function readTask(id: string): TaskItem | null {
  const nid = parseId(id);
  if (nid === undefined) return null;
  const task = taskStore.get(nid);
  if (!task) return null;
  const out = outgoing(node(nid));
  const parentEdge = incoming(node(nid), "subtask")[0];
  return assemble(task, out, parentEdge);
}

/**
 * The Tasks linked to ONE session, resolved from that session's edges rather
 * than by listing every Task and filtering.
 *
 * `listTasks` reads the whole table plus the whole link table and assembles
 * every row before its `session` filter drops all but a handful — 42ms against
 * production data, paid TWICE by every `SessionState` (`listSessionTasks` and
 * `listRelatedGlobalTasks` each called it) and therefore by every session open
 * and every `broadcastState`. A session has a handful of linked Tasks, and the
 * `context` edges that name them are indexed, so this walks in from the session
 * instead: one edge query plus a read per linked Task.
 *
 * Same visibility rules as the list it replaces: deleted and archived Tasks are
 * not linked Tasks, and the order is the shared planning order.
 */
function sessionLinkedTasks(sessionId: string): TaskItem[] {
  const ids = new Set<string>();
  for (const edge of incoming(sessionNode(sessionId), "context"))
    if (edge.fromType === "task") ids.add(edge.fromId);
  const items: TaskItem[] = [];
  for (const id of ids) {
    const nid = parseId(id);
    if (nid === undefined) continue;
    const task = taskStore.get(nid);
    // `taskStore.get` already refuses a deleted Task; an archived one is not a
    // linked Task either (the list this replaces filtered it out).
    if (!task || task.archivedAt !== undefined) continue;
    items.push(
      assemble(task, outgoing(node(nid)), incoming(node(nid), "subtask")[0]),
    );
  }
  return order(items);
}

function sessionTaskSummaries(sessionId: string): TaskSummary[] {
  return sessionLinkedTasks(sessionId).map(toSummary);
}

export function listSessionTasks(
  _kind: AgentType,
  sessionId: string,
): TaskSummary[] {
  return sessionTaskSummaries(sessionId);
}

export function listRelatedGlobalTasks(
  _kind: AgentType,
  sessionId: string,
): TaskSummary[] {
  return sessionTaskSummaries(sessionId).filter(
    (task) =>
      !(task.sessionRefs ?? []).some(
        (ref) => ref.sessionId === sessionId && ref.origin === "task-start",
      ),
  );
}

export function findOriginTask(sessionId: string): TaskBackRef | undefined {
  for (const edge of incoming(sessionNode(sessionId), "context")) {
    if ((edge.metadata as SessionEdgeMeta | undefined)?.origin !== "task-start")
      continue;
    const item = readTask(edge.fromId);
    if (item) return { id: item.id, title: item.title, status: item.status };
  }
  return undefined;
}

/* -------------------------------- mutate --------------------------------- */

export function createTask(input: CreateTaskInput): TaskItem {
  const dueDateValue = normalizeDateOnly(input.dueDate);
  const scheduledForValue = normalizeDateOnly(input.scheduledFor);
  const task = taskStore.create({
    title: cleanText(input.title, 200),
    description: stripInjectedRelayHistory(input.description ?? ""),
    status: input.status ?? "todo",
    priority: normalizePriority(input.priority),
    ...(dueDateValue !== undefined ? { dueDate: dueDateValue } : {}),
    ...(scheduledForValue !== undefined
      ? { scheduledFor: scheduledForValue }
      : {}),
    // TYPED vs ARRIVED is the caller's statement, NOT an inference from
    // `createdBy`. Slack shortcut intake, for instance, honestly records the
    // user as the creator (they asked for it) while still being an arrival they
    // have not processed — deriving triage from `createdBy` silently kept every
    // Slack Task out of the Inbox it is advertised to land in. Default is
    // untriaged: the ONE path where a Task is typed straight into the Backlog
    // says so (`connection.ts` `onSaveTask`).
    ...(input.triaged ? { triagedAt: Date.now() } : {}),
    ...(input.source?.agentType
      ? { sourceAgentType: input.source.agentType }
      : {}),
    ...(input.source?.sessionId
      ? { sourceSessionId: input.source.sessionId }
      : {}),
    createdBy: input.source?.createdBy === "user" ? "user" : "agent",
  });
  const cascaded = applyRelations(task.id, {
    // Only when the caller stated one: an omitted project is inherited from
    // `parentId`, and passing null here would clear it again.
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    jiraIssueKeys: normalizeJiraKeys(input.jiraIssueKeys),
    githubIssues: normalizeGithubIssueRefs(input.githubIssues),
    externalLinks: normalizeExternalLinks(input.externalLinks),
    parentId: input.parentId ?? null,
    // A Task is BORN with a place. Leaving it unpositioned used to hand the
    // Backlog nothing but recency to sort it by, so working on a fresh capture
    // moved it; `nextSortOrder` picks the end of the group it joins.
    sortOrder:
      input.sortOrder ??
      taskStore.nextSortOrder(
        (input.parentId ? parseId(input.parentId) : undefined) ?? null,
      ),
    sessionRefs: normalizeSessionRefs(input.sessionRefs),
  });
  notify([String(task.id), ...cascaded]);
  return readTask(String(task.id))!;
}

export function updateTask(id: string, patch: UpdateTaskInput): TaskItem {
  const nid = parseId(id);
  const current = nid !== undefined ? readTask(id) : null;
  if (nid === undefined || !current) throw new Error(`Task not found: ${id}`);

  const statusWrite = resolveStatusWrite(current, patch);
  const triage = resolveTriage(current, patch);

  if (
    statusWrite.status !== undefined &&
    statusWrite.status !== current.status
  ) {
    taskStore.addStatusEvent(
      nid,
      current.status,
      statusWrite.status,
      patch.actor ?? { kind: "system" },
    );
  }

  taskStore.update(nid, {
    ...(patch.title !== undefined
      ? { title: cleanText(patch.title, 200) }
      : {}),
    ...(patch.description !== undefined
      ? { description: stripInjectedRelayHistory(patch.description) }
      : {}),
    ...(statusWrite.status !== undefined ? { status: statusWrite.status } : {}),
    ...statusWrite.suggestionColumns,
    ...triage,
    ...(patch.priority !== undefined
      ? { priority: patch.priority === null ? "normal" : patch.priority }
      : {}),
    ...(patch.dueDate !== undefined
      ? {
          dueDate:
            patch.dueDate === null
              ? null
              : (normalizeDateOnly(patch.dueDate) ?? null),
        }
      : {}),
    ...(patch.scheduledFor !== undefined
      ? {
          scheduledFor:
            patch.scheduledFor === null
              ? null
              : (normalizeDateOnly(patch.scheduledFor) ?? null),
        }
      : {}),
    ...(patch.commitHash !== undefined ? { commitHash: patch.commitHash } : {}),
    ...(patch.committedAt !== undefined
      ? { committedAt: patch.committedAt }
      : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
  });
  if (patch.archivedAt !== undefined) {
    taskStore.setArchived(nid, patch.archivedAt !== null);
    // A Task comes back from the archive holding the index it had when it left,
    // which the Backlog has long since given to somebody else. It rejoins its
    // group like any other arrival, which is also how it gets seen again. Only a
    // real RETURN does: unarchiving is not rejected on a Task that is already
    // live, and repeating it may not move a row the user placed.
    if (
      patch.archivedAt === null &&
      current.archivedAt !== undefined &&
      patch.sortOrder === undefined
    )
      taskStore.update(nid, {
        sortOrder: taskStore.nextSortOrder(taskStore.parentOf(nid) ?? null),
      });
  }

  const cascaded = applyRelations(nid, {
    ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
    ...(patch.jiraIssueKeys !== undefined
      ? { jiraIssueKeys: normalizeJiraKeys(patch.jiraIssueKeys) }
      : {}),
    ...(patch.githubIssues !== undefined
      ? { githubIssues: normalizeGithubIssueRefs(patch.githubIssues) }
      : {}),
    ...(patch.externalLinks !== undefined
      ? { externalLinks: normalizeExternalLinks(patch.externalLinks) }
      : {}),
    ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    ...(patch.sessionRefs !== undefined
      ? { sessionRefs: normalizeSessionRefs(patch.sessionRefs) }
      : {}),
  });
  notify([id, ...cascaded]);
  return readTask(id)!;
}

export function archiveTask(id: string, actor?: TaskStatusActor): TaskItem {
  return updateTask(id, {
    archivedAt: Date.now(),
    ...(actor ? { actor } : {}),
  });
}

export function unarchiveTask(id: string, actor?: TaskStatusActor): TaskItem {
  return updateTask(id, { archivedAt: null, ...(actor ? { actor } : {}) });
}

/**
 * Archive Tasks completed more than 14 days ago unless their direct parent is
 * still active. Each eligible row goes through `archiveTask`, so ordinary Task
 * change notifications and broadcasts remain the only lifecycle path.
 */
export function sweepCompletedTaskArchive(now = Date.now()): string[] {
  if (autoArchiveSweepRunning) return [];
  autoArchiveSweepRunning = true;
  try {
    const cutoff = now - TASK_AUTO_ARCHIVE_AFTER_MS;
    const tasks = taskStore.list({ includeArchived: true });
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const eligible = tasks.filter((task) => {
      if (
        task.archivedAt !== undefined ||
        task.status !== "done" ||
        task.completedAt === undefined ||
        task.completedAt >= cutoff
      )
        return false;
      const parentId = taskStore.parentOf(task.id);
      if (parentId === undefined) return true;
      const parent = byId.get(parentId);
      return parent?.status === "done" || parent?.archivedAt !== undefined;
    });
    for (const task of eligible) archiveTask(String(task.id));
    return eligible.map((task) => String(task.id));
  } finally {
    autoArchiveSweepRunning = false;
  }
}

function runTaskAutoArchiveSweep(
  trigger: "boot" | "hourly" | "post-write",
): void {
  try {
    sweepCompletedTaskArchive();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[tasks] ${trigger} auto-archive sweep failed; will retry later: ${detail}`,
    );
  }
}

/** Run the best-effort retention sweep at boot and hourly thereafter. Idempotent. */
export function startTaskAutoArchiveSweep(): void {
  if (autoArchiveTimer) return;
  runTaskAutoArchiveSweep("boot");
  autoArchiveTimer = setInterval(
    () => runTaskAutoArchiveSweep("hourly"),
    TASK_AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
  );
  autoArchiveTimer.unref?.();
}

export function stopTaskAutoArchiveSweep(): void {
  if (!autoArchiveTimer) return;
  clearInterval(autoArchiveTimer);
  autoArchiveTimer = undefined;
}

export function deleteTask(id: string): void {
  const nid = parseId(id);
  if (nid === undefined || !taskStore.get(nid))
    throw new Error(`Task not found: ${id}`);
  // Read the children BEFORE the edge cleanup: `remove` drops this Task's
  // `subtask` edges, so every child silently becomes a root and nothing
  // afterwards can tell that it ever had this parent. A child left unreported
  // keeps a `parentId` pointing at a Task that no longer exists, and the next
  // Backlog drag sends that dead id back as a placement — which `reorderTasks`
  // refuses, failing the whole reorder.
  const orphaned = taskStore.children(nid).map((child) => String(child.id));
  taskStore.remove(nid); // tombstone + edge cleanup
  notify([id, ...orphaned]);
}

/**
 * Link a session to a task, upserting by session id. A `task-start` origin always
 * wins over `reference`. Origin/handle live in the `context` edge metadata.
 */
export function linkSessionToTask(
  id: string,
  ref: TaskSessionRef,
): TaskItem | null {
  const nid = parseId(id);
  if (nid === undefined || !taskStore.get(nid)) return null;
  const prev = outgoing(node(nid), "context").find(
    (e) => e.toId === ref.sessionId,
  )?.metadata as SessionEdgeMeta | undefined;
  const origin: TaskSessionOrigin | undefined =
    ref.origin === "task-start" || prev?.origin === "task-start"
      ? "task-start"
      : (ref.origin ?? prev?.origin);
  const harness = ref.harness ?? prev?.harness;
  const agentType = ref.agentType ?? prev?.agentType;
  const sessionFile = ref.sessionFile ?? prev?.sessionFile;
  const attachedAt = ref.attachedAt ?? prev?.attachedAt;
  addLink(node(nid), "context", sessionNode(ref.sessionId), {
    metadata: {
      ...(harness !== undefined ? { harness } : {}),
      ...(agentType !== undefined ? { agentType } : {}),
      ...(sessionFile !== undefined ? { sessionFile } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(attachedAt !== undefined ? { attachedAt } : {}),
    } satisfies SessionEdgeMeta,
  });
  notify([id]);
  return readTask(id);
}

/** Remove every reference to a deleted session: drop its `context` edges. Returns changed ids. */
export function unlinkSessionEverywhere(sessionId: string): string[] {
  const changed = new Set<string>();
  for (const edge of incoming(sessionNode(sessionId), "context")) {
    removeLink(
      { type: "task", id: edge.fromId },
      "context",
      sessionNode(sessionId),
    );
    changed.add(edge.fromId);
  }
  if (changed.size) notify(changed);
  return [...changed];
}

/**
 * Persist manual sibling ordering + parent hierarchy without touching content.
 *
 * `byUser` marks a drag in the Backlog, and it triages ONLY the Tasks whose
 * PARENT actually moved. A drop renumbers every sibling in the target group, so
 * triaging the whole placement list would silently process a dozen arrivals
 * because one of them was dragged past them; a REPARENT, by contrast, is an
 * unambiguous decision about that one Task. Pure order changes are deliberately
 * not triage — see `resolveTriage`.
 */
export function reorderTasks(
  orderedIds: string[],
  placements?: TaskReorderPlacement[],
  byUser = false,
): void {
  const order = placements?.length
    ? placements
    : orderedIds.map((id) => ({ id, parentId: undefined }));
  const siblingIndex = new Map<string, number>();
  const seen = new Set<string>();
  const reparented: number[] = [];
  const touched = new Set<string>();
  for (const placement of order) {
    const childId = parseId(placement.id.trim());
    if (childId === undefined || !taskStore.get(childId))
      throw new Error(`Task not found: ${placement.id}`);
    if (seen.has(placement.id))
      throw new Error(`Duplicate task in reorder request: ${placement.id}`);
    seen.add(placement.id);
    const parentRaw = placement.parentId?.trim() || undefined;
    let parentId: number | null = null;
    if (parentRaw) {
      const p = parseId(parentRaw);
      if (p === undefined || !taskStore.get(p))
        throw new Error(`Parent task not found: ${parentRaw}`);
      parentId = p;
    }
    const previousParent = taskStore.parentOf(childId);
    // A client never SEES an archived parent: the Task list it reorders omits
    // archived rows, so the Backlog draws a child of an archived epic at the
    // root and sends it back as a root placement. That null is the VIEW
    // talking, not the user detaching anything — honouring it would silently
    // destroy the edge the epic needs to come back with its subtasks, on the
    // next drag anywhere in the list. Only a named parent moves such a child.
    const hiddenParent =
      parentId === null &&
      previousParent !== undefined &&
      taskStore.get(previousParent)?.archivedAt !== undefined;
    if (!hiddenParent) {
      if (byUser && (previousParent ?? null) !== parentId)
        reparented.push(childId);
      // enforces single-parent + acyclic, and reports the subtree a project
      // inheritance moved with it.
      for (const id of taskStore.setParent(childId, parentId))
        touched.add(String(id));
    }
    const key = parentRaw ?? "";
    const index = siblingIndex.get(key) ?? 0;
    siblingIndex.set(key, index + 1);
    taskStore.update(childId, { sortOrder: index });
    touched.add(String(childId));
  }
  const now = Date.now();
  for (const id of reparented) {
    if (taskStore.get(id)?.triagedAt === undefined)
      taskStore.update(id, { triagedAt: now });
  }
  notify(touched);
}

/* ------------------------------- assembly -------------------------------- */

interface SessionEdgeMeta {
  harness?: Harness;
  agentType?: AgentType;
  sessionFile?: string;
  origin?: TaskSessionOrigin;
  attachedAt?: number;
}

function assemble(
  task: ReturnType<typeof taskStore.get> & object,
  out: Link[],
  parentEdge: Link | undefined,
): TaskItem {
  const t = task!;
  const jira = out.filter((e) => e.relation === "jira").map((e) => e.toId);
  const githubIssues = out
    .filter((e) => e.relation === "github")
    .map((e) => e.toId);
  const externalLinks = out
    .filter((e) => e.relation === "link")
    .map(edgeToExternalLink);
  const projectId = out.find((e) => e.relation === "in_project")?.toId;
  const sessionRefs = out
    .filter((e) => e.relation === "context")
    .map((e) => sessionRefFromEdge(e));
  const description = t.description ?? "";
  const agentTypeValue =
    t.sourceAgentType as TaskSummary["source"]["agentType"];
  const descriptionPreviewValue = preview(description);
  return {
    id: String(t.id),
    title: t.title,
    status: t.status,
    description,
    ...(descriptionPreviewValue !== undefined
      ? { descriptionPreview: descriptionPreviewValue }
      : {}),
    ...(projectId ? { projectId } : {}),
    jiraIssueKeys: jira,
    ...(githubIssues.length ? { githubIssues } : {}),
    externalLinks,
    ...(t.dueDate ? { dueDate: t.dueDate } : {}),
    ...(t.scheduledFor ? { scheduledFor: t.scheduledFor } : {}),
    ...(t.triagedAt !== undefined ? { triagedAt: t.triagedAt } : {}),
    ...(t.statusSuggestionTo !== undefined && t.statusSuggestionAt !== undefined
      ? {
          statusSuggestion: {
            to: t.statusSuggestionTo as TaskStatusSuggestion["to"],
            at: t.statusSuggestionAt,
            ...(t.statusSuggestionBy
              ? { sessionId: t.statusSuggestionBy }
              : {}),
            ...(t.statusSuggestionReason
              ? { reason: t.statusSuggestionReason }
              : {}),
          },
        }
      : {}),
    priority: t.priority,
    sessionRefs,
    ...(parentEdge ? { parentId: parentEdge.fromId } : {}),
    ...(t.sortOrder !== undefined ? { sortOrder: t.sortOrder } : {}),
    source: {
      createdBy: t.createdBy,
      ...(t.sourceAgentType
        ? {
            ...(agentTypeValue !== undefined
              ? { agentType: agentTypeValue }
              : {}),
          }
        : {}),
      ...(t.sourceSessionId ? { sessionId: t.sourceSessionId } : {}),
    },
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.completedAt !== undefined ? { completedAt: t.completedAt } : {}),
    ...(t.archivedAt !== undefined ? { archivedAt: t.archivedAt } : {}),
    ...(t.commitHash ? { commitHash: t.commitHash } : {}),
    ...(t.committedAt !== undefined ? { committedAt: t.committedAt } : {}),
  };
}

/**
 * The one narrowing from `TaskItem` to `TaskSummary` lives in the shared
 * package (`taskSummaryOf`), because the browser projects too when it settles
 * an optimistic create against the mutator's full reply. Re-exported here so
 * server callers keep asking the Task domain for it.
 */
export { taskSummaryOf };

const toSummary = taskSummaryOf;

function sessionRefFromEdge(edge: Link): TaskSessionRef {
  const m = (edge.metadata ?? {}) as SessionEdgeMeta;
  return {
    ...(m.harness ? { harness: m.harness } : {}),
    ...(m.agentType ? { agentType: m.agentType } : {}),
    sessionId: edge.toId,
    ...(m.sessionFile ? { sessionFile: m.sessionFile } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.attachedAt !== undefined ? { attachedAt: m.attachedAt } : {}),
  };
}

function edgeToExternalLink(edge: Link): TaskExternalLink {
  const m = (edge.metadata ?? {}) as {
    kind?: TaskExternalLinkType;
    source?: TaskExternalLinkSource;
    title?: string;
  };
  const type: TaskExternalLinkType =
    m.kind === "related" ? "related" : "source";
  const source =
    m.source && m.source !== "unknown"
      ? m.source
      : detectExternalLinkSource(edge.toId);
  return {
    url: edge.toId,
    type,
    source,
    ...(m.title ? { title: m.title } : {}),
    addedAt: edge.createdAt,
  };
}

/**
 * Apply the relational side of a create/update (only the provided keys), and
 * return the OTHER task ids it moved — the subtree a project cascade reached.
 * The caller reports them with its own id through `notify`, because their list
 * rows changed just as much as the one being saved.
 */
function applyRelations(
  taskId: number,
  rel: {
    projectId?: string | null;
    jiraIssueKeys?: string[];
    githubIssues?: string[];
    externalLinks?: TaskExternalLink[];
    parentId?: string | null;
    sortOrder?: number | null;
    sessionRefs?: TaskSessionRef[];
  },
): string[] {
  const cascaded = new Set<string>();
  // Parent first: `setParent` inherits the parent's project, so a projectId
  // stated in the SAME write has to land after it to win.
  if (rel.parentId !== undefined) {
    const parent = rel.parentId ? parseId(rel.parentId) : null;
    const previous = taskStore.parentOf(taskId) ?? null;
    for (const id of taskStore.setParent(taskId, parent ?? null))
      cascaded.add(String(id));
    // A Task that MOVED groups without being dragged there — a `task_manage`
    // reparent, any save carrying a `parentId` — would otherwise keep the index
    // it held among its old siblings and collide with a real one here. Only the
    // drag (`reorderTasks`) states a position; every other move asks for a free
    // one.
    if ((parent ?? null) !== previous && rel.sortOrder == null)
      taskStore.update(taskId, {
        sortOrder: taskStore.nextSortOrder(parent ?? null),
      });
  }
  if (rel.projectId !== undefined) {
    for (const id of taskStore.setProject(
      taskId,
      rel.projectId?.trim() || null,
    ))
      cascaded.add(String(id));
  }
  if (rel.jiraIssueKeys !== undefined)
    taskStore.setJira(taskId, rel.jiraIssueKeys);
  if (rel.githubIssues !== undefined)
    taskStore.setGithubIssues(taskId, rel.githubIssues);
  if (rel.externalLinks !== undefined) {
    // Rebuild url edges from the given set.
    for (const e of outgoing(node(taskId), "link"))
      removeLink(node(taskId), "link", { type: "url", id: e.toId });
    for (const link of rel.externalLinks) {
      addLink(
        node(taskId),
        "link",
        { type: "url", id: link.url },
        {
          metadata: { kind: link.type, source: link.source, title: link.title },
        },
      );
    }
  }
  if (rel.sortOrder !== undefined && rel.sortOrder !== null)
    taskStore.update(taskId, { sortOrder: rel.sortOrder });
  if (rel.sessionRefs !== undefined) {
    for (const e of outgoing(node(taskId), "context"))
      removeLink(node(taskId), "context", { type: "session", id: e.toId });
    for (const ref of rel.sessionRefs) {
      addLink(node(taskId), "context", sessionNode(ref.sessionId), {
        metadata: {
          ...(ref.harness !== undefined ? { harness: ref.harness } : {}),
          ...(ref.agentType !== undefined ? { agentType: ref.agentType } : {}),
          ...(ref.sessionFile !== undefined
            ? { sessionFile: ref.sessionFile }
            : {}),
          ...(ref.origin !== undefined ? { origin: ref.origin } : {}),
          ...(ref.attachedAt !== undefined
            ? { attachedAt: ref.attachedAt }
            : {}),
        } satisfies SessionEdgeMeta,
      });
    }
  }
  cascaded.delete(String(taskId));
  return [...cascaded];
}

/* -------------------------------- triage ---------------------------------- */

/**
 * Mark a Task PROCESSED by the user, idempotently.
 *
 * This is the invariant's one home: `connection.ts` applies it to every browser
 * command that represents a user decision, so triage no longer depends on
 * whether each individual domain call happens to accept an actor. Threading
 * `actor` by hand produced a steady trickle of holes — assigning a project,
 * archiving, commenting — each of which looked like a user edit and left the
 * Task waiting in the Inbox.
 *
 * It never MOVES an existing timestamp: when a Task was processed is a fact
 * about the first decision, not the most recent touch.
 */
export function markTaskProcessed(id: string): void {
  const nid = parseId(id);
  if (nid === undefined) return;
  const task = taskStore.get(nid);
  if (!task || task.triagedAt !== undefined) return;
  taskStore.update(nid, { triagedAt: Date.now() });
  notify([id]);
}

/**
 * When a Task stops waiting in the Inbox.
 *
 * Triage is IMPLICIT on any user edit: if you changed something about a Task,
 * you have seen it, and asking you to also dismiss it would be a second chore
 * for a decision you already made. The explicit `triaged` flag exists for the
 * one act that changes nothing else — dismissing something that needs no action
 * — and for putting a Task back.
 *
 * Deliberately NOT triggered by merely READING a Task. An inbox that empties
 * itself when you glance at a row is one you cannot use to keep track of what
 * you still owe an answer to, and opening a Task from a link or a search would
 * silently process it.
 */
function resolveTriage(
  current: TaskItem,
  patch: UpdateTaskInput,
): { triagedAt?: number | null } {
  if (patch.triaged !== undefined)
    return { triagedAt: patch.triaged ? Date.now() : null };
  if (patch.actor?.kind !== "user") return {};
  return current.triagedAt === undefined ? { triagedAt: Date.now() } : {};
}

/* --------------------------- status suggestions --------------------------- */

interface StatusSuggestionColumns {
  statusSuggestionTo?: TaskStatus | null;
  statusSuggestionAt?: number | null;
  statusSuggestionBy?: string | null;
  statusSuggestionReason?: string | null;
}

/**
 * The two statuses an agent may SUGGEST. `doing` is deliberately not one of
 * them: saying nothing means "leave it in doing", which is the truth when work
 * is paused mid-flight, so there is nothing for a third value to express.
 */
function suggestibleStatus(
  status: TaskStatus | undefined,
): TaskStatusSuggestion["to"] | undefined {
  return status === "done" || status === "todo" ? status : undefined;
}

/**
 * Who may actually WRITE a Task's status, and what an agent's write becomes
 * instead. The one place that decides this.
 *
 * An agent reporting `done` is a claim, not evidence — the reported failure was
 * agents marking Tasks done eagerly, after which the Task vanished from every
 * open list with the work unfinished. So an `agent` actor's `done`/`todo` is
 * recorded as a SUGGESTION for the user to answer.
 *
 * A `done` suggestion also moves the Task out of `doing`, because both halves
 * of "I finished, and I am no longer working on it" are true at once and an
 * agent should not need a second corrective write to say the second one. The
 * Task lands in `todo` — waiting for an answer, on nobody's plate — rather than
 * in `done`, which is still the user's call.
 *
 * `system` actors are deliberately NOT covered, and `userRequestedStatus` is
 * the explicit escape hatch: when the user asked for the status in this
 * session, the agent's write is applied AND recorded as the claim, so it reads
 * as "done at your request" and stays reversible.
 *
 * A suggestion is cleared when the user actually decides: moving the Task to
 * another status, or dismissing it outright (`clearStatusSuggestion`). An
 * ordinary save that leaves the status untouched must NOT clear it, or editing
 * a link would silently discard the suggestion.
 */
function resolveStatusWrite(
  current: TaskItem,
  patch: UpdateTaskInput,
): {
  status: TaskStatus | undefined;
  suggestionColumns: StatusSuggestionColumns;
} {
  const byAgent = patch.actor?.kind === "agent";
  const clear: StatusSuggestionColumns = {
    statusSuggestionTo: null,
    statusSuggestionAt: null,
    statusSuggestionBy: null,
    statusSuggestionReason: null,
  };
  const suggested = byAgent ? suggestibleStatus(patch.status) : undefined;

  if (suggested && suggested !== current.status) {
    const recorded: StatusSuggestionColumns = {
      statusSuggestionTo: suggested,
      statusSuggestionAt: Date.now(),
      statusSuggestionBy: patch.actor?.id ?? null,
      statusSuggestionReason: cleanText(patch.statusReason ?? "", 200) || null,
    };
    // Repeating the SAME suggestion keeps the first one's timestamp: how long
    // something has sat unanswered is the useful fact, and a retrying agent
    // would reset it. A DIFFERENT one replaces it — the agent changed its mind,
    // and the live statement is the newer one.
    const columns = current.statusSuggestion?.to === suggested ? {} : recorded;
    if (patch.userRequestedStatus)
      return { status: suggested, suggestionColumns: columns };
    return {
      status:
        suggested === "done" && current.status === "doing" ? "todo" : undefined,
      suggestionColumns: columns,
    };
  }

  if (patch.clearStatusSuggestion)
    return { status: patch.status, suggestionColumns: clear };
  if (
    patch.status !== undefined &&
    !byAgent &&
    patch.status !== current.status
  ) {
    return { status: patch.status, suggestionColumns: clear };
  }
  return { status: patch.status, suggestionColumns: {} };
}

/* ------------------------------- ordering -------------------------------- */

function order(items: TaskItem[]): TaskItem[] {
  const out: TaskItem[] = [];
  for (const status of ["doing", "todo", "done"] as const) {
    out.push(
      ...items.filter((t) => t.status === status).sort(comparePlanningOrder),
    );
  }
  return out;
}

function comparePlanningOrder(a: TaskItem, b: TaskItem): number {
  return (
    priorityRank(b.priority) - priorityRank(a.priority) ||
    dateRank(a.dueDate) - dateRank(b.dueDate) ||
    a.createdAt - b.createdAt ||
    a.title.localeCompare(b.title)
  );
}

function priorityRank(priority: unknown): number {
  const p = normalizePriority(priority);
  return p === "urgent" ? 3 : p === "high" ? 2 : p === "normal" ? 1 : 0;
}

function dateRank(date: string | undefined): number {
  return date
    ? new Date(`${date}T00:00:00`).getTime()
    : Number.MAX_SAFE_INTEGER;
}

function matchesDue(
  item: TaskItem,
  filter: NonNullable<TaskListFilter["due"]>,
): boolean {
  if (item.status === "done") return false;
  const due = normalizeDateOnly(item.dueDate);
  const today = localDateKey(new Date());
  if (filter === "unscheduled") return !due;
  if (!due) return false;
  if (filter === "overdue") return due < today;
  if (filter === "today") return due === today;
  return due > today;
}

/**
 * Plan-day filter over `scheduledFor`. `past` is what a DATE buys over a
 * today/tomorrow enum: a Task planned for a day that has been and gone is
 * unfinished work, and it says so by itself.
 */
function matchesScheduled(
  item: TaskItem,
  filter: NonNullable<TaskListFilter["scheduled"]>,
): boolean {
  if (item.status === "done") return false;
  const planned = normalizeDateOnly(item.scheduledFor);
  const today = localDateKey(new Date());
  if (filter === "unplanned") return !planned;
  if (!planned) return false;
  if (filter === "past") return planned < today;
  if (filter === "today") return planned === today;
  if (filter === "tomorrow") return planned === localDateKeyOffset(1);
  return planned > today;
}

function matchesQuery(item: TaskItem, query: string): boolean {
  if (item.title.toLowerCase().includes(query)) return true;
  if ((item.descriptionPreview ?? "").toLowerCase().includes(query))
    return true;
  if ((item.description ?? "").toLowerCase().includes(query)) return true;
  if (item.projectId?.toLowerCase().includes(query)) return true;
  if ((item.jiraIssueKeys ?? []).some((k) => k.toLowerCase().includes(query)))
    return true;
  if ((item.githubIssues ?? []).some((r) => r.toLowerCase().includes(query)))
    return true;
  if (
    (item.externalLinks ?? []).some((l) =>
      [l.url, l.title, l.source, l.type].some((v) =>
        v?.toLowerCase().includes(query),
      ),
    )
  )
    return true;
  if (item.dueDate?.toLowerCase().includes(query)) return true;
  if (item.priority?.toLowerCase().includes(query)) return true;
  return false;
}

/* ----------------------------- normalization ----------------------------- */

function normalizePriority(priority: unknown): TaskPriority {
  return priority === "low" || priority === "high" || priority === "urgent"
    ? priority
    : "normal";
}

function normalizeDateOnly(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (!match) return undefined;
  const date = new Date(`${match[1]}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : match[1];
}

function normalizeJiraKeys(values: unknown): string[] {
  const candidates = Array.isArray(values) ? values : [];
  const all = candidates
    .map((v) => cleanOptional(v)?.toUpperCase())
    .filter(
      (v): v is string =>
        typeof v === "string" && /^[A-Z][A-Z0-9]+-\d+$/.test(v),
    );
  return [...new Set(all)];
}

function normalizeExternalLinks(values: unknown): TaskExternalLink[] {
  if (!Array.isArray(values)) return [];
  const out: TaskExternalLink[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (!raw || typeof raw !== "object") continue;
    const url = normalizeUrl((raw as { url?: unknown }).url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const type: TaskExternalLinkType =
      (raw as { type?: unknown }).type === "related" ? "related" : "source";
    const requested = (raw as { source?: unknown }).source;
    const source =
      isTaskExternalLinkSource(requested) && requested !== "unknown"
        ? requested
        : detectExternalLinkSource(url);
    const titleValue =
      cleanText((raw as { title?: unknown }).title, 120) || undefined;
    out.push({
      url,
      type,
      source,
      ...(titleValue !== undefined ? { title: titleValue } : {}),
    });
  }
  return out;
}

function detectExternalLinkSource(url: string): TaskExternalLinkSource {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("slack.com")) return "slack";
    if (
      host.includes("atlassian.net") ||
      /(^|\.)jira\./.test(host) ||
      /\/browse\/[A-Z][A-Z0-9]+-\d+\b/i.test(parsed.pathname)
    )
      return "jira";
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    // Forgejo is self-hosted: the only thing that identifies it is the
    // configured instance, so an unconfigured one classifies nothing.
    if (isForgejoInstanceUrl(url, getForgejoBaseUrl())) return "forgejo";
  } catch {
    /* fall through */
  }
  return "unknown";
}

function normalizeUrl(value: unknown): string | undefined {
  const text = cleanOptional(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSessionRefs(refs: unknown): TaskSessionRef[] {
  if (!Array.isArray(refs)) return [];
  const out: TaskSessionRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const sessionId = cleanOptional((ref as { sessionId?: unknown }).sessionId);
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const r = ref as TaskSessionRef;
    const originRaw = (ref as { origin?: unknown }).origin;
    out.push({
      ...(r.harness ? { harness: r.harness } : {}),
      ...(r.agentType ? { agentType: r.agentType } : {}),
      sessionId,
      ...(r.sessionFile ? { sessionFile: r.sessionFile } : {}),
      ...(originRaw === "task-start" || originRaw === "reference"
        ? { origin: originRaw }
        : {}),
      ...(typeof r.attachedAt === "number" ? { attachedAt: r.attachedAt } : {}),
    });
  }
  return out;
}

/**
 * Remove the legacy auto-injected "## Relay history" block older relay code
 * appended to task descriptions (always last, so drop to end).
 */
function stripInjectedRelayHistory(description: string): string {
  return description.replace(/\n*##\s*Relay history\b[\s\S]*$/i, "").trimEnd();
}

/**
 * The user-local calendar date `days` away from `base`.
 *
 * Advancing the DATE rather than adding 24h in milliseconds is what makes this
 * DST-safe. On a 25-hour autumn fallback day, `base + 86_400_000` can still
 * land on `base`'s own local date — verified at 00:30 on 2026-10-25 in Central
 * European Time — so "tomorrow" resolved to today and every Task planned for
 * tomorrow vanished from the filter for the first hour of that day.
 *
 * Exported for the DST tests: the invariant is that shifting by one day always
 * changes the date key, in every zone and across every transition.
 */
export function shiftLocalDateKey(
  base: Date,
  days: number,
  timeZone = userTimeZone(),
): string {
  const date = new Date(`${localDateOf(base.getTime(), timeZone)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDateKeyOffset(days: number): string {
  return shiftLocalDateKey(new Date(), days);
}

function localDateKey(date: Date): string {
  return localDateOf(date.getTime(), userTimeZone());
}

function preview(markdown: string): string | undefined {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`\-[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 240) : undefined;
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function cleanOptional(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
