/**
 * Tasks — SQLite-backed (see docs/tasks/PLAN.md).
 *
 * This module exposes the current `TaskItem`/`TaskSummary` shape while the
 * storage is SQLite via {@link ./db/taskStore.ts} and the generic
 * {@link ./db/links.ts} graph:
 *   - intrinsic fields              → the `tasks` row
 *   - parent/project/session/ticket/url → `links` edges
 *
 * Tasks link to each other through `blocks` and `relates` edges (rules in
 * `taskStore.setTaskLink`). Ids surface as stringified integers ("42").
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
  TaskInitiativeRef,
  TaskItem,
  TaskLinkedTask,
  TaskLinkInput,
  TaskLinks,
  TaskPriority,
  TaskReorderPlacement,
  TaskSessionOrigin,
  TaskSessionRef,
  TaskStatus,
  TaskStatusSuggestion,
  TaskSummary,
  TaskTicket,
} from "@assistant/shared";
import {
  isForgejoInstanceUrl,
  isTaskExternalLinkSource,
  normalizeTaskTicket,
  taskSummaryOf,
} from "@assistant/shared";
import { getDb, withDbTransaction } from "./db/index.ts";
import { taskStore, type TaskStatusActor } from "./db/taskStore.ts";
import {
  initiativeStore,
  type InitiativeMembership,
} from "./db/initiativeStore.ts";
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
  ticket?: TaskTicket;
  externalLinks?: TaskExternalLink[];
  dueDate?: string;
  scheduledFor?: string;
  priority?: TaskPriority;
  sessionRefs?: TaskSessionRef[];
  parentId?: string;
  sortOrder?: number;
  /** Links to other Tasks, written with the Task or not at all. */
  addLinks?: TaskLinkInput[];
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
  /** Replaces the ticket; null removes it. */
  ticket?: TaskTicket | null;
  externalLinks?: TaskExternalLink[];
  dueDate?: string | null;
  scheduledFor?: string | null;
  priority?: TaskPriority | null;
  sessionRefs?: TaskSessionRef[];
  parentId?: string | null;
  sortOrder?: number | null;
  /** Dismiss a pending status suggestion without applying it. */
  clearStatusSuggestion?: boolean;
  /**
   * Links to other Tasks. Each REPLACES any existing link with that Task; the
   * update is written whole or not at all.
   */
  addLinks?: TaskLinkInput[];
  /** Task ids whose link with this Task, whatever its type, is removed. */
  removeLinks?: string[];
  /** One short line recorded with an agent's status claim. */
  statusReason?: string;
  /**
   * An `agent` actor's `done`/`todo` is only SUGGESTED, for the user to answer,
   * instead of applied. The opt-in for a finish the agent could not verify
   * itself; without it the agent's status is applied.
   */
  suggestOnly?: boolean;
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
 *
 * The same act reports the Initiatives that hold a touched Task, as a member
 * or below one, because their progress counts and graphs read these rows
 * (docs/initiatives.md). A write that can take a Task OUT of an Initiative — a
 * delete, a move to another parent — reads the holders before it writes and
 * passes them as `formerHolders`: afterwards nothing links them any more. Such
 * a write also reports the subtree of a Task whose `initiatives` it changed
 * (`movedMembershipSubtrees`), since every Task below lists them too.
 */
function notify(
  ids: Iterable<string>,
  formerHolders: readonly number[] = [],
  holders = true,
): void {
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
  try {
    if (holders) initiativeStore.touchHolders(numeric, formerHolders);
  } catch (error) {
    // The Task write is durable already; a failed fan-out leaves the counts of
    // the Initiatives holding it behind until their next write, so say so.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[tasks] Initiative fan-out failed: ${detail}`);
  }
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
 *
 * An Initiative write reporting the Tasks whose `initiatives` it changed passes
 * `{ holders: false }`: those Task rows did not change, so the Initiatives
 * reading them have nothing new, and the holder fan-out would only bump the
 * writing Initiative a second time and every other one holding the same Tasks.
 */
export function notifyTaskChange(
  ids: Iterable<string>,
  options: { holders?: boolean } = {},
): void {
  notify(ids, [], options.holders ?? true);
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
  let blockerCounts: Map<string, number> | undefined;
  for (const id of new Set(ids)) {
    const entry = index.get(id);
    if (!entry) continue;
    if (!entry.live) {
      events.push({ kind: "delete", id, revision: entry.revision });
      continue;
    }
    blockerCounts ??= openTaskBlockerCounts();
    const item = taskSummaryFor(id, blockerCounts);
    if (item)
      events.push({ kind: "upsert", id, revision: entry.revision, item });
  }
  return events;
}

/**
 * The live-projection summary for one Task, or null when it is not in it
 * (archived, tombstoned, never existed) — which is exactly when the domain owes
 * its viewers a `delete` rather than an `upsert`.
 *
 * A caller projecting several Tasks passes one `openTaskBlockerCounts()` map
 * for the batch; alone, the Task's own count is one indexed query.
 */
export function taskSummaryFor(
  id: string,
  blockerCounts?: ReadonlyMap<string, number>,
): TaskSummary | null {
  const nid = parseId(id);
  const item = nid === undefined ? null : readTaskItem(nid, false);
  if (!item || item.archivedAt !== undefined) return null;
  return toSummary(
    withOpenBlockers(
      item,
      blockerCounts
        ? blockerCounts.get(id)
        : taskStore.openBlockerCounts(nid).get(nid!),
    ),
  );
}

/**
 * A Task's current state-event revision, for a reply that hands a viewer the
 * full Task: the client marks that detail stale only on an event NEWER than
 * this, so a write's own echo does not refetch what the reply already holds.
 */
export function taskRevision(id: string): number | undefined {
  const nid = parseId(id);
  return nid === undefined ? undefined : taskStore.get(nid)?.revision;
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

  const blockerCounts = openTaskBlockerCounts();
  return order(items).map((item) =>
    toSummary(withOpenBlockers(item, blockerCounts.get(item.id))),
  );
}

/** One full Task, with its links to other Tasks resolved (`TaskItem.links`). */
export function readTask(id: string): TaskItem | null {
  const nid = parseId(id);
  return nid === undefined ? null : readTaskItem(nid, true);
}

function readTaskItem(nid: number, withLinks: boolean): TaskItem | null {
  const task = taskStore.get(nid);
  if (!task) return null;
  const out = outgoing(node(nid));
  const inc = incoming(node(nid));
  const item = assemble(
    task,
    out,
    inc.find((edge) => edge.relation === "subtask"),
  );
  if (!withLinks) return item;
  const initiatives = taskInitiatives(nid);
  return {
    ...item,
    ...resolveTaskLinks(taskStore.taskLinkIdsFrom(out, inc)),
    ...(initiatives.length ? { initiatives } : {}),
  };
}

/** The live Initiatives holding a Task, directly or through an ancestor. */
function taskInitiatives(nid: number): TaskInitiativeRef[] {
  return (initiativeStore.membershipsOf([nid]).get(nid) ?? []).map(
    (membership) => ({
      id: String(membership.initiativeId),
      title: membership.title,
      state: membership.state,
      ...(membership.through
        ? {
            through: {
              id: String(membership.through.taskId),
              title: membership.through.title,
            },
          }
        : {}),
    }),
  );
}

/** Attach how many open blockers hold the Task up; nothing when none do. */
function withOpenBlockers<T extends TaskItem>(
  item: T,
  count: number | undefined,
): T {
  return count ? { ...item, openBlockerCount: count } : item;
}

/**
 * The linked Tasks behind a Task's link ids, and whether one of its blockers is
 * still open: neither done nor archived.
 */
function resolveTaskLinks(
  ids: ReturnType<typeof taskStore.taskLinkIds>,
): Pick<TaskItem, "links" | "blocked" | "openBlockerCount"> {
  if (!ids.blocks.length && !ids.blockedBy.length && !ids.relates.length)
    return {};
  const linked = (list: number[]): TaskLinkedTask[] =>
    list.flatMap((id) => {
      const task = taskStore.get(id);
      if (!task) return [];
      const projectId = taskStore.projectOf(id);
      return [
        {
          id: String(id),
          title: task.title,
          status: task.status,
          ...(projectId ? { projectId } : {}),
          archived: task.archivedAt !== undefined,
        },
      ];
    });
  const links: TaskLinks = {
    blocks: linked(ids.blocks),
    blockedBy: linked(ids.blockedBy),
    relates: linked(ids.relates),
  };
  // The same rule as `taskStore.openBlockerCounts`, read off the blockers this
  // detail already resolved rather than queried a second time.
  const openBlockerCount = links.blockedBy.filter(
    (blocker) => blocker.status !== "done" && !blocker.archived,
  ).length;
  return {
    links,
    ...(openBlockerCount ? { openBlockerCount, blocked: true as const } : {}),
  };
}

/**
 * Open blockers per blocked Task id — blockers neither done nor archived. A
 * Task absent from the map is not blocked.
 */
export function openTaskBlockerCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [id, n] of taskStore.openBlockerCounts())
    counts.set(String(id), n);
  return counts;
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
  const tasks = sessionLinkedTasks(sessionId);
  if (!tasks.length) return [];
  const blockerCounts = openTaskBlockerCounts();
  return tasks.map((item) =>
    toSummary(withOpenBlockers(item, blockerCounts.get(item.id))),
  );
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

/**
 * `createTask`, `updateTask` and `deleteTask` own their transaction and notify
 * only after it commits, so they are TOP-LEVEL ONLY. Inside a caller's
 * transaction there is no savepoint to roll back to: a caught failure would
 * commit half an operation with no event, and a success would stamp revisions
 * before the outer commit. Refused before anything is written.
 */
function assertTopLevelWrite(name: string): void {
  if (getDb().isTransaction)
    throw new Error(
      `${name} must not run inside an open database transaction.`,
    );
}

export function createTask(input: CreateTaskInput): TaskItem {
  assertTopLevelWrite("createTask");
  const dueDateValue = normalizeDateOnly(input.dueDate);
  const scheduledForValue = normalizeDateOnly(input.scheduledFor);
  // Refused before anything is written.
  const ticketValue =
    input.ticket !== undefined ? ticketInput(input.ticket) : undefined;
  const linkChanges = taskLinkChanges(input.addLinks, undefined);
  // One transaction: a link that breaks a rule leaves no half-made Task behind.
  const { task, touched } = withDbTransaction(() => {
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
      ...(ticketValue ? { ticket: ticketValue } : {}),
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
    return {
      task,
      touched: [...cascaded, ...applyTaskLinkChanges(task.id, linkChanges)],
    };
  });
  notify([String(task.id), ...touched]);
  return readTask(String(task.id))!;
}

export function updateTask(id: string, patch: UpdateTaskInput): TaskItem {
  assertTopLevelWrite("updateTask");
  const nid = parseId(id);
  const current = nid !== undefined ? readTaskItem(nid, false) : null;
  if (nid === undefined || !current) throw new Error(`Task not found: ${id}`);
  const ticketValue =
    patch.ticket !== undefined ? ticketInput(patch.ticket) : undefined;

  const statusWrite = resolveStatusWrite(current, patch);
  const triage = resolveTriage(current, patch);
  const linkChanges = taskLinkChanges(patch.addLinks, patch.removeLinks);
  const formerHolders =
    patch.parentId !== undefined ? initiativeStore.holdersOf([nid]) : [];
  const membershipBefore =
    patch.parentId !== undefined
      ? initiativeStore.membershipsOf([nid])
      : undefined;

  // One transaction: a link that breaks a rule writes none of the update.
  const touched = withDbTransaction(() => {
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
      ...(statusWrite.status !== undefined
        ? { status: statusWrite.status }
        : {}),
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
      ...(patch.commitHash !== undefined
        ? { commitHash: patch.commitHash }
        : {}),
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
      ...(ticketValue !== undefined ? { ticket: ticketValue } : {}),
      ...(patch.externalLinks !== undefined
        ? { externalLinks: normalizeExternalLinks(patch.externalLinks) }
        : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      ...(patch.sessionRefs !== undefined
        ? { sessionRefs: normalizeSessionRefs(patch.sessionRefs) }
        : {}),
    });
    if (patch.parentId !== undefined) dropNestedMemberships([nid]);
    return [
      ...cascaded,
      ...applyTaskLinkChanges(nid, linkChanges),
      ...(linkedStateChanged(current, patch, statusWrite.status)
        ? taskStore.linkedTaskIds(nid).map(String)
        : []),
    ];
  });
  notify(
    [
      id,
      ...touched,
      ...(membershipBefore
        ? movedMembershipSubtrees(membershipBefore, [nid])
        : []),
    ],
    formerHolders,
  );
  return readTask(id)!;
}

/**
 * Whether a write changes what this Task's LINKED Tasks show of it: the title
 * and status their detail views list, and — through status and archiving — the
 * open-blocker count on the Tasks it blocks. Any of these reports every linked
 * Task (`blocks` both ways, and `relates`) in the write's one notification;
 * other fields, a description or a priority, report none.
 */
function linkedStateChanged(
  current: TaskItem,
  patch: UpdateTaskInput,
  status: TaskStatus | undefined,
): boolean {
  return (
    (patch.title !== undefined &&
      cleanText(patch.title, 200) !== current.title) ||
    (status !== undefined && status !== current.status) ||
    (patch.archivedAt !== undefined &&
      (patch.archivedAt !== null) !== (current.archivedAt !== undefined))
  );
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
  assertTopLevelWrite("deleteTask");
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
  // Its linked Tasks lose their links to it in the same cleanup, and their
  // viewers have to hear that just as much.
  const linked = taskStore.linkedTaskIds(nid).map(String);
  // The cleanup drops its membership edges and the `subtask` edges its
  // children joined Initiatives through, so the Initiatives are read first.
  const formerHolders = initiativeStore.holdersOf([nid]);
  // A Task held by an Initiative takes that membership from its whole subtree
  // (`TaskItem.initiatives`), whose viewers are told like a move's.
  const unheld = initiativeStore.membershipsOf([nid]).has(nid)
    ? initiativeStore.subtreeIds([nid]).map(String)
    : [];
  taskStore.remove(nid); // tombstone + edge cleanup
  notify([id, ...orphaned, ...linked, ...unheld], formerHolders);
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
  assertTopLevelWrite("reorderTasks");
  const order: TaskReorderPlacement[] = placements?.length
    ? placements
    : orderedIds.map((id) => ({ id }));
  // A move takes a Task out of the Initiatives its old parent held it in.
  const placed = order
    .map((placement) => parseId(placement.id.trim()))
    .filter((id): id is number => id !== undefined);
  const formerHolders = initiativeStore.holdersOf(placed);
  const membershipBefore = initiativeStore.membershipsOf(placed);
  // One transaction: a placement refused late in the list (a Task another tab
  // deleted, a duplicate, a cycle) must not leave the earlier moves written
  // without the notification that reports them — that is a hierarchy, and an
  // Initiative's membership, changing with nobody told.
  const touched = withDbTransaction(() => applyReorder(order, byUser));
  notify(
    [...touched, ...movedMembershipSubtrees(membershipBefore, placed)],
    formerHolders,
  );
}

function applyReorder(
  order: readonly TaskReorderPlacement[],
  byUser: boolean,
): Set<string> {
  const siblingIndex = new Map<string, number>();
  const seen = new Set<string>();
  const reparented: number[] = [];
  const moved: number[] = [];
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
      if ((previousParent ?? null) !== parentId) {
        moved.push(childId);
        if (byUser) reparented.push(childId);
      }
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
  dropNestedMemberships(moved);
  return touched;
}

/**
 * A Task moved under another member of an Initiative it was a plain member of
 * (or one holding plain members below it) is now covered twice; its plain edge
 * goes, since its new ancestor already makes it a member. Inside the move's
 * transaction, so the hierarchy and the stored membership never disagree; the
 * notification after it reports those Initiatives as current holders.
 */
function dropNestedMemberships(moved: readonly number[]): void {
  if (!moved.length) return;
  for (const initiativeId of initiativeStore.holdersOf(moved))
    initiativeStore.dropCoveredPlainEdges(initiativeId);
}

/**
 * The Tasks a move changed `TaskItem.initiatives` for, read after it: the
 * subtree of each moved Task whose Initiatives, or the ancestor it is held
 * through, differ from `before`. A Task below it is held through it or
 * through its own nearer ancestors, which moved with it, so the subtree
 * changes only when its moved head does.
 */
function movedMembershipSubtrees(
  before: ReadonlyMap<number, InitiativeMembership[]>,
  moved: readonly number[],
): string[] {
  const after = initiativeStore.membershipsOf(moved);
  const key = (list: readonly InitiativeMembership[] | undefined) =>
    (list ?? [])
      .map((entry) => `${entry.initiativeId}:${entry.through?.taskId ?? ""}`)
      .join(",");
  const changed = moved.filter(
    (taskId) => key(before.get(taskId)) !== key(after.get(taskId)),
  );
  return initiativeStore.subtreeIds(changed).map(String);
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
  const ticketEdge = out.find(
    (e) => e.relation === "jira" || e.relation === "github",
  );
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
    ...(ticketEdge
      ? {
          ticket: {
            source: ticketEdge.relation as TaskTicket["source"],
            ref: ticketEdge.toId,
          },
        }
      : {}),
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
    ticket?: TaskTicket | null;
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
  if (rel.ticket !== undefined) taskStore.setTicket(taskId, rel.ticket);
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

/* ------------------------------ task links -------------------------------- */

/** One operation's link writes, checked for shape and conflicts up front. */
interface TaskLinkChanges {
  add: Array<{ type: TaskLinkInput["type"]; taskId: number }>;
  remove: number[];
}

const TASK_LINK_TYPES = new Set<string>(["blocks", "blocked-by", "relates"]);

function linkTargetId(raw: unknown): number {
  const id = typeof raw === "string" ? parseId(raw.trim()) : undefined;
  if (id === undefined)
    throw new Error(`Not a Task id to link: ${JSON.stringify(raw)}.`);
  return id;
}

/**
 * Normalize an operation's `addLinks` / `removeLinks`. One operation may name a
 * Task once: two links to it, or adding and removing it together, would leave
 * the outcome to argument order.
 */
function taskLinkChanges(
  add: readonly TaskLinkInput[] | undefined,
  remove: readonly string[] | undefined,
): TaskLinkChanges {
  const changes: TaskLinkChanges = { add: [], remove: [] };
  const named = new Set<number>();
  const claim = (id: number) => {
    if (named.has(id))
      throw new Error(
        `Task-${id} is named more than once in this operation's links; give each Task one link change.`,
      );
    named.add(id);
  };
  for (const link of add ?? []) {
    if (!TASK_LINK_TYPES.has(link?.type))
      throw new Error(
        `Unknown Task link type ${JSON.stringify(link?.type)}; use blocks, blocked-by or relates.`,
      );
    const taskId = linkTargetId(link.taskId);
    claim(taskId);
    changes.add.push({ type: link.type, taskId });
  }
  for (const raw of remove ?? []) {
    const taskId = linkTargetId(raw);
    claim(taskId);
    changes.remove.push(taskId);
  }
  return changes;
}

/**
 * Write one operation's link changes for `taskId`, inside the caller's
 * transaction, and return the OTHER Tasks whose links moved: a link is a fact
 * about both of its ends, so both owe their viewers an event.
 */
function applyTaskLinkChanges(
  taskId: number,
  changes: TaskLinkChanges,
): string[] {
  const touched = new Set<number>();
  for (const other of changes.remove)
    for (const id of taskStore.removeTaskLink(taskId, other)) touched.add(id);
  for (const { type, taskId: other } of changes.add) {
    const ids =
      type === "blocked-by"
        ? taskStore.setTaskLink(other, "blocks", taskId)
        : taskStore.setTaskLink(taskId, type, other);
    for (const id of ids) touched.add(id);
  }
  touched.delete(taskId);
  return [...touched].map(String);
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
 * The two statuses an agent's claim can name. `doing` is deliberately not one
 * of them: saying nothing means "leave it in doing", which is the truth when
 * work is paused mid-flight, so there is nothing for a third value to express.
 */
function claimableStatus(
  status: TaskStatus | undefined,
): TaskStatusSuggestion["to"] | undefined {
  return status === "done" || status === "todo" ? status : undefined;
}

/**
 * Who may actually WRITE a Task's status, and what an agent's write becomes.
 * The one place that decides this.
 *
 * An `agent` actor's `done`/`todo` is APPLIED, and the claim behind it — which
 * status, when, which session, why — is recorded beside it. Its `to` equals the
 * status, so it is ANSWERED provenance the Task page shows, never a pending
 * question. Initiatives are run end to end by agents, so the default trusts
 * them; the record keeps every agent status change visible and reversible.
 *
 * `suggestOnly` is the explicit opt-in for a finish the agent could not verify
 * itself: the claim is recorded as a SUGGESTION for the user to answer and the
 * status is left alone — except that a `done` suggestion also moves the Task
 * out of `doing`, because both halves of "I finished, and I am no longer
 * working on it" are true at once and an agent should not need a second
 * corrective write to say the second one. The Task lands in `todo` — waiting
 * for an answer, on nobody's plate — rather than in `done`, which is then the
 * user's call. The PR-merge `done` suggestion takes this path.
 *
 * `system` actors are deliberately NOT covered.
 *
 * A claim is cleared when the user actually decides: moving the Task to
 * another status, or dismissing it outright (`clearStatusSuggestion`). An
 * ordinary save that leaves the status untouched must NOT clear it, or editing
 * a link would silently discard a pending suggestion.
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
  const claimed = byAgent ? claimableStatus(patch.status) : undefined;
  // Repeating the current status is a decision only when it settles an
  // opposing pending claim; otherwise preserve absent or answered provenance.
  const hasOpposingPendingSuggestion =
    current.statusSuggestion !== undefined &&
    current.statusSuggestion.to !== current.status;

  if (
    claimed &&
    (claimed !== current.status ||
      (!patch.suggestOnly && hasOpposingPendingSuggestion))
  ) {
    const recorded: StatusSuggestionColumns = {
      statusSuggestionTo: claimed,
      statusSuggestionAt: Date.now(),
      statusSuggestionBy: patch.actor?.id ?? null,
      statusSuggestionReason: cleanText(patch.statusReason ?? "", 200) || null,
    };
    // An applied status is provenance of THIS write, so the claim is always
    // this agent's own, even over a pending suggestion with the same target.
    if (!patch.suggestOnly)
      return { status: claimed, suggestionColumns: recorded };
    // Repeating the SAME suggestion keeps the first one's timestamp: how long
    // something has sat unanswered is the useful fact, and a retrying agent
    // would reset it. A DIFFERENT one replaces it — the agent changed its mind,
    // and the live statement is the newer one.
    return {
      status:
        claimed === "done" && current.status === "doing" ? "todo" : undefined,
      suggestionColumns:
        current.statusSuggestion?.to === claimed ? {} : recorded,
    };
  }

  if (patch.clearStatusSuggestion)
    return { status: patch.status, suggestionColumns: clear };
  if (patch.status === undefined || patch.status === current.status)
    return { status: patch.status, suggestionColumns: {} };
  if (!byAgent) return { status: patch.status, suggestionColumns: clear };
  // An agent moving the Task to `doing` leaves a PENDING suggestion standing,
  // but an ANSWERED claim described the status being left: kept, it would
  // turn into a question nobody asked.
  return {
    status: patch.status,
    suggestionColumns:
      current.statusSuggestion?.to === current.status ? clear : {},
  };
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
  if (item.ticket?.ref.toLowerCase().includes(query)) return true;
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

/**
 * A stated ticket in canonical form; null removes it. A value naming no ticket
 * is refused rather than read as a removal.
 */
function ticketInput(value: unknown): TaskTicket | null {
  if (value === null) return null;
  const ticket = normalizeTaskTicket(value);
  if (!ticket)
    throw new Error(
      `Not a ticket: ${JSON.stringify(value)}. Use a Jira key such as 'ABC-123', a GitHub 'owner/repo#123', or the issue's URL.`,
    );
  return ticket;
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
