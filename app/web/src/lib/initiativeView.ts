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
import {
  INITIATIVE_LAYOUT_COLLAPSE_LIMIT,
  type InitiativeDetail,
  type InitiativeGraphNode,
  type InitiativeState,
  type SessionListItem,
  type TaskStatus,
  type TaskSummary,
} from "@assistant/shared";
import { isTaskWorking } from "./taskActivity.ts";

/** One Task as the page draws it: the read's facts with the live ones over them. */
export interface InitiativeMember {
  id: string;
  title: string;
  status: TaskStatus;
  /** An open blocker holds it up; never set on a done or archived Task. */
  blocked: boolean;
  /**
   * How many of its blockers are open: the live Task row's count, else the
   * read's `blocks` links into it whose blocker is open by the same facts.
   */
  openBlockers: number;
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
  "id" | "title" | "status" | "archived" | "projectId"
>;

/** A Task's status and archive state, live where the Tasks topic says. */
function stateOf(
  node: TaskFacts,
  live: ReadonlyMap<string, TaskSummary> | null,
): { status: TaskStatus; archived: boolean } {
  const row = live?.get(node.id);
  // A row in the live list is unarchived by definition: the Tasks topic holds
  // only the live projection (`docs/state-sync.md`).
  return row
    ? { status: row.status, archived: false }
    : { status: node.status, archived: node.archived === true };
}

function memberOf(
  node: TaskFacts,
  live: ReadonlyMap<string, TaskSummary> | null,
  running: ReadonlySet<string>,
  /** Its open blockers counted over the read's links, for want of a row. */
  heldOpenBlockers: number,
  extra: Pick<InitiativeMember, "milestone"> &
    Partial<Pick<InitiativeMember, "parentId">>,
): InitiativeMember {
  const row = live?.get(node.id);
  const { status, archived } = stateOf(node, live);
  const openBlockers = row ? (row.openBlockerCount ?? 0) : heldOpenBlockers;
  const blocked = status !== "done" && !archived && openBlockers > 0;
  const projectId = row?.projectId ?? node.projectId;
  return {
    id: node.id,
    title: row?.title ?? node.title,
    status,
    blocked,
    openBlockers,
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
  // A Task without a live row counts its open blockers over the read's links
  // (every `blocks` link into a member is one), judging each blocker by the
  // same live-or-read facts the map draws it with.
  const open = new Set<string>();
  for (const node of [...detail.nodes, ...detail.externalBlockers]) {
    const { status, archived } = stateOf(node, live);
    if (status !== "done" && !archived) open.add(node.id);
  }
  const heldOpenBlockers = new Map<string, number>();
  for (const edge of detail.edges)
    if (open.has(edge.from))
      heldOpenBlockers.set(edge.to, (heldOpenBlockers.get(edge.to) ?? 0) + 1);
  const members = new Map<string, InitiativeMember>();
  for (const node of detail.nodes)
    members.set(
      node.id,
      memberOf(node, live, running, heldOpenBlockers.get(node.id) ?? 0, {
        milestone: node.milestone === true,
        ...(node.parentId ? { parentId: node.parentId } : {}),
      }),
    );
  // An outside blocker's own blockers are not in the read: only a live row
  // counts them.
  for (const blocker of detail.externalBlockers)
    if (!members.has(blocker.id))
      members.set(
        blocker.id,
        memberOf(blocker, live, running, 0, { milestone: false }),
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

/* ------------------------------- collapse -------------------------------- */

/** A member's member children, in the read's order. */
export function memberChildren(
  detail: Pick<InitiativeDetail, "nodes">,
): ReadonlyMap<string, readonly string[]> {
  const children = new Map<string, string[]>();
  for (const node of detail.nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  return children;
}

function compareTaskIds(a: string, b: string): number {
  return Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The collapsed set as the server applies it (`docs/initiatives.md`, Layout
 * and placement): an id collapses when it has member children and no ancestor
 * in the set does, ascending by id, and no more than a `getInitiative` may
 * carry. The page keeps the user's whole wish, nested epics included, and
 * sends and compares only this, so two wishes that draw the same map are one
 * request and the server's own normalisation never asks for another read.
 */
export function canonicalCollapsed(
  detail: Pick<InitiativeDetail, "nodes">,
  wanted: readonly string[],
): string[] {
  if (wanted.length === 0) return [];
  const children = memberChildren(detail);
  const parentOf = new Map<string, string>();
  for (const node of detail.nodes)
    if (node.parentId) parentOf.set(node.id, node.parentId);
  const wish = new Set(wanted.filter((id) => children.has(id)));
  const applied: string[] = [];
  for (const id of wish) {
    let covered = false;
    // Up the parent chain; a stored hierarchy cycle ends the walk.
    const seen = new Set([id]);
    for (
      let parent = parentOf.get(id);
      parent !== undefined && !seen.has(parent);
      parent = parentOf.get(parent)
    ) {
      seen.add(parent);
      if (wish.has(parent)) {
        covered = true;
        break;
      }
    }
    if (!covered) applied.push(id);
  }
  return collapseRequest(applied);
}

/**
 * A collapsed set as a `getInitiative` carries it: each id once, ascending, no
 * more than the server takes.
 */
export function collapseRequest(ids: readonly string[]): string[] {
  return [...new Set(ids)]
    .sort(compareTaskIds)
    .slice(0, INITIATIVE_LAYOUT_COLLAPSE_LIMIT);
}

/** Two canonical sets name the same drawing. */
export function sameCollapsed(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Every member a collapsed epic stands for: its descendants, milestones aside. */
export function collapsedAway(
  detail: Pick<InitiativeDetail, "nodes">,
  collapsed: readonly string[],
): ReadonlyMap<string, string> {
  const by = new Map<string, string>();
  if (collapsed.length === 0) return by;
  const children = memberChildren(detail);
  const milestones = new Set(
    detail.nodes.filter((node) => node.milestone).map((node) => node.id),
  );
  for (const epic of collapsed) {
    const stack = [...(children.get(epic) ?? [])];
    const seen = new Set([epic]);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!milestones.has(id)) by.set(id, epic);
      stack.push(...(children.get(id) ?? []));
    }
  }
  return by;
}

/** A member's descendants, counted from the live facts. */
export interface SubtreeFacts {
  total: number;
  /** Done descendants, archived ones too, as the Initiative's own count. */
  done: number;
  /** The member and everything under it is done. */
  allDone: boolean;
}

/**
 * Every member's {@link SubtreeFacts} in one pass, children before parents:
 * the read lists members depth-first from the roots. A collapsed epic's
 * "7/14 done" and Hide done both read it, so both follow the Tasks topic.
 */
export function subtreeFacts(
  detail: Pick<InitiativeDetail, "nodes">,
  members: ReadonlyMap<string, InitiativeMember>,
): ReadonlyMap<string, SubtreeFacts> {
  const facts = new Map<string, SubtreeFacts>();
  for (let i = detail.nodes.length - 1; i >= 0; i -= 1) {
    const node = detail.nodes[i]!;
    const own = facts.get(node.id) ?? { total: 0, done: 0, allDone: true };
    const done = members.get(node.id)?.status === "done";
    own.allDone &&= done;
    facts.set(node.id, own);
    if (!node.parentId || node.parentId === node.id) continue;
    const parent = facts.get(node.parentId) ?? {
      total: 0,
      done: 0,
      allDone: true,
    };
    parent.total += own.total + 1;
    parent.done += own.done + (done ? 1 : 0);
    parent.allDone &&= own.allDone;
    facts.set(node.parentId, parent);
  }
  return facts;
}

/**
 * What "Hide done" takes off the page: a done member with nothing open under
 * it, and a done outside blocker. A done epic over open work stays, so the
 * open work keeps its place and its collapse control. A local display choice:
 * nothing is written.
 */
export function hiddenDoneIds(
  detail: Pick<InitiativeDetail, "nodes" | "externalBlockers">,
  members: ReadonlyMap<string, InitiativeMember>,
  facts: ReadonlyMap<string, SubtreeFacts>,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const node of detail.nodes)
    if (facts.get(node.id)?.allDone) hidden.add(node.id);
  for (const blocker of detail.externalBlockers)
    if (members.get(blocker.id)?.status === "done") hidden.add(blocker.id);
  return hidden;
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
      `blocked by ${member.openBlockers} open ${member.openBlockers === 1 ? "task" : "tasks"}`,
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
