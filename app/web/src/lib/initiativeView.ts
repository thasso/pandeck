/**
 * What an Initiative page draws, from its keyed read plus the live Task topic
 * (`docs/initiatives.md`, The Initiative page).
 *
 * The read is as of a revision, and a newer Initiative revision re-reads it.
 * Between reads a member's status, title and blocked state come from the Tasks
 * topic instead, so a status change recolours a node at once, with no read and
 * no layout. The overlay never adds or removes a member: membership, hierarchy
 * and geometry are the read's alone.
 *
 * Framework-free by the `lib/` contract.
 */
import type {
  InitiativeDetail,
  InitiativeGraphNode,
  InitiativeState,
  SessionListItem,
  TaskStatus,
  TaskSummary,
} from "@assistant/shared";
import { isTaskWorking } from "./taskActivity.ts";

/** One Task as the page draws it: the read's facts with the live ones over them. */
export interface InitiativeMember {
  id: string;
  title: string;
  status: TaskStatus;
  /** An open blocker holds it up; never set on a done or archived Task. */
  blocked: boolean;
  /** How many blockers are open, when the live Task row says. */
  openBlockers?: number;
  /** Shelved: drawn toned back, and neither startable nor blocked. */
  archived: boolean;
  /** A todo Task that is neither blocked nor archived. Computed, never stored. */
  startable: boolean;
  /** A session started from the Task is running a turn right now. */
  running: boolean;
  milestone: boolean;
  projectId?: string;
  parentId?: string;
}

/**
 * The Tasks topic as an overlay, or null while it is not authoritative: a list
 * hydrated from the shell cache can be older than the read, so only a list the
 * current socket episode answered may speak over it.
 */
export function liveTaskIndex(
  tasks: readonly TaskSummary[] | undefined,
  fresh: boolean,
): ReadonlyMap<string, TaskSummary> | null {
  if (!fresh || !tasks) return null;
  return new Map(tasks.map((task) => [task.id, task]));
}

/**
 * Tasks a session is WORKING on right now: one started from the Task
 * (`task-start`) that is running a turn. A session that only referenced the
 * Task (a search, a scan, a mention) does not count, and neither does the
 * Task's own `doing` status; this is the Backlog's one definition
 * (`lib/taskActivity.ts`).
 */
export function runningTaskIds(
  live: ReadonlyMap<string, TaskSummary> | null,
  sessions: readonly SessionListItem[],
): ReadonlySet<string> {
  const running = new Set<string>();
  if (!live) return running;
  const sessionById = new Map(
    sessions
      .filter((session) => session.isStreaming)
      .map((session) => [session.id, session]),
  );
  if (sessionById.size === 0) return running;
  for (const task of live.values())
    if (isTaskWorking(task, sessionById)) running.add(task.id);
  return running;
}

type TaskFacts = Pick<
  InitiativeGraphNode,
  "id" | "title" | "status" | "blocked" | "archived" | "projectId"
>;

function memberOf(
  node: TaskFacts,
  live: ReadonlyMap<string, TaskSummary> | null,
  running: ReadonlySet<string>,
  extra: Pick<InitiativeMember, "milestone"> &
    Partial<Pick<InitiativeMember, "parentId">>,
): InitiativeMember {
  const row = live?.get(node.id);
  // A row in the live list is unarchived by definition: the Tasks topic holds
  // only the live projection (`docs/state-sync.md`).
  const status = row?.status ?? node.status;
  const archived = row ? false : node.archived === true;
  const openBlockers = row ? (row.openBlockerCount ?? 0) : undefined;
  const blocked =
    status !== "done" &&
    !archived &&
    (openBlockers !== undefined ? openBlockers > 0 : node.blocked === true);
  const projectId = row?.projectId ?? node.projectId;
  return {
    id: node.id,
    title: row?.title ?? node.title,
    status,
    blocked,
    ...(blocked && openBlockers ? { openBlockers } : {}),
    archived,
    startable: status === "todo" && !blocked && !archived,
    running: running.has(node.id),
    milestone: extra.milestone,
    ...(projectId ? { projectId } : {}),
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
  };
}

/** Every member and outside blocker of the read, keyed by Task id. */
export function initiativeMembers(
  detail: InitiativeDetail,
  live: ReadonlyMap<string, TaskSummary> | null,
  running: ReadonlySet<string>,
): ReadonlyMap<string, InitiativeMember> {
  const members = new Map<string, InitiativeMember>();
  for (const node of detail.nodes)
    members.set(
      node.id,
      memberOf(node, live, running, {
        milestone: node.milestone === true,
        ...(node.parentId ? { parentId: node.parentId } : {}),
      }),
    );
  for (const blocker of detail.externalBlockers)
    if (!members.has(blocker.id))
      members.set(
        blocker.id,
        memberOf(blocker, live, running, { milestone: false }),
      );
  return members;
}

/** Done of total over a member's descendants: an epic's own progress line. */
interface SubtreeProgress {
  total: number;
  done: number;
}

export interface MemberTreeRow {
  member: InitiativeMember;
  depth: number;
  /** Present on a member with member children. */
  progress?: SubtreeProgress;
  children: MemberTreeRow[];
}

/**
 * The members as a tree, each Task exactly once. The read lists them
 * depth-first from the roots with `parentId` only where the parent is a member
 * too, so a milestone under an epic stays under it (marked) rather than being
 * drawn a second time beside the roots. Done counts archived descendants too,
 * as the Initiative's own count does.
 */
export function memberTree(
  detail: InitiativeDetail,
  members: ReadonlyMap<string, InitiativeMember>,
): MemberTreeRow[] {
  const children = new Map<string, InitiativeGraphNode[]>();
  for (const node of detail.nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const seen = new Set<string>();
  const build = (id: string, depth: number): MemberTreeRow | null => {
    const member = members.get(id);
    if (!member || seen.has(id)) return null;
    seen.add(id);
    const rows = (children.get(id) ?? [])
      .map((child) => build(child.id, depth + 1))
      .filter((row): row is MemberTreeRow => row !== null);
    const row: MemberTreeRow = { member, depth, children: rows };
    if (rows.length > 0) {
      const progress = { total: 0, done: 0 };
      const count = (list: MemberTreeRow[]) => {
        for (const child of list) {
          progress.total += 1;
          if (child.member.status === "done") progress.done += 1;
          count(child.children);
        }
      };
      count(rows);
      row.progress = progress;
    }
    return row;
  };
  return detail.rootIds
    .map((id) => build(id, 0))
    .filter((row): row is MemberTreeRow => row !== null);
}

/** Flatten a tree in reading order, for keyboard order and test assertions. */
export function flattenTree(rows: readonly MemberTreeRow[]): MemberTreeRow[] {
  const out: MemberTreeRow[] = [];
  const walk = (list: readonly MemberTreeRow[]) => {
    for (const row of list) {
      out.push(row);
      walk(row.children);
    }
  };
  walk(rows);
  return out;
}

/** The milestones in the user's order, with their live facts. */
export function milestoneMembers(
  detail: InitiativeDetail,
  members: ReadonlyMap<string, InitiativeMember>,
): InitiativeMember[] {
  return detail.milestoneIds
    .map((id) => members.get(id))
    .filter((member): member is InitiativeMember => member !== undefined);
}

export const INITIATIVE_STATE_LABEL: Record<InitiativeState, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
};

/** The index page's groups, in the order a reader scans them. */
export const INITIATIVE_STATE_ORDER: readonly InitiativeState[] = [
  "active",
  "paused",
  "done",
];

/** A member's state as one phrase: the status, then what holds it. */
export function memberStateLabel(member: InitiativeMember): string {
  const status =
    member.status === "done"
      ? "Done"
      : member.status === "doing"
        ? "In progress"
        : member.startable
          ? "Ready to start"
          : "To do";
  const parts = [status];
  if (member.blocked)
    parts.push(
      member.openBlockers
        ? `blocked by ${member.openBlockers} open ${member.openBlockers === 1 ? "task" : "tasks"}`
        : "blocked",
    );
  if (member.archived) parts.push("archived");
  if (member.running) parts.push("a session is running");
  return parts.join(", ");
}

/**
 * The fragment that selects a member on an Initiative page, so a selection
 * survives a reload and back/forward passes through it
 * (`app/web/docs/ui-shell.md`: a part of an object is a fragment).
 */
export function initiativeTaskFragment(taskId: string): string {
  return `#task-${encodeURIComponent(taskId)}`;
}

export function selectedTaskFromHash(hash: string): string | null {
  const match = hash.match(/^#task-(.+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
