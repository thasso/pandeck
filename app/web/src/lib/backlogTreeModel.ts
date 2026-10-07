import type { ProjectRecord, TaskStatus } from "@assistant/shared";
import {
  applyGroupMove,
  applyMove,
  type TreeNode,
} from "../components/common/tree-model.ts";
import { flattenTasks, type FlatTask, type Task } from "./backlogTree.ts";
import { projectColor, resolveProjectDisplay } from "./projectDisplay.ts";
import type { RowDensity } from "./rowDensity.ts";

/**
 * Domain → `TreeNode` mapping for the Backlog, layered on the generic
 * `components/common/Tree`. The Tree stays domain-free (it speaks `TreeNode<T>`);
 * this module turns the app's flat `Task[]` (each carrying `parentId` +
 * `sortOrder`) into the two hierarchies the Backlog renders:
 *
 *  - the **task hierarchy** (Normal view): tasks nested by parent/child, and
 *  - the **project layer** (By Project view): projects as collapsible depth-0
 *    nodes whose children are that project's tasks.
 *
 * It also owns the status-filter pruning shared by both views and the project
 * filter type/helpers. Keep this file pure (no React).
 */

export const ALL_STATUSES: readonly TaskStatus[] = ["todo", "doing", "done"];

/** Data carried by a task row in either tree. */
type TaskNodeData = {
  kind: "task";
  task: Task;
  /** Full-subtree descendant counts (ignoring collapse), for the progress rollup. */
  descendantCount: number;
  doneDescendantCount: number;
  /** True when this row is kept only as context for a matching descendant
   * (status filter): shown dimmed and not the filter's actual hit. */
  context?: boolean;
};

/** Data carried by a project header row in the project-layer tree. */
type ProjectNodeData = {
  kind: "project";
  /** Stable node id/key (also the TreeNode id). */
  key: string;
  /** Registry project id, or `null` for the Unassigned pseudo-project. */
  projectId: string | null;
  label: string;
  known: boolean;
  dot?: string;
  stripe?: string;
  taskCount: number;
};

export type BacklogNodeData = TaskNodeData | ProjectNodeData;
export type BacklogNode = TreeNode<BacklogNodeData>;

export type BacklogProjectFilter =
  | { kind: "all" }
  | { kind: "project"; projectId: string }
  | { kind: "unassigned" };

export const ALL_PROJECT_FILTER: BacklogProjectFilter = { kind: "all" };

/** Backlog list layout: flat task hierarchy vs. grouped-by-project. */
export type BacklogViewMode = "normal" | "project";

/**
 * How much room a Backlog surface gives one Task, decided by the HOST rather
 * than read off the viewport.
 *
 * `tight` is a single 28px line for a surface with nothing else to hit — the
 * composer's Task picker, where width is the only real constraint. `comfortable`
 * is two lines — title, then the id and what is going on with the Task — with
 * every secondary control a full-height thumb target. Both exist because the two
 * things the old `compact` boolean stood for are independent: a picker is fine at
 * 28px however coarse the pointer is. Density therefore follows the affordances a
 * surface offers, not the screen it is on.
 */
export type BacklogDensity = RowDensity;

/**
 * What the sidebar's Backlog renders at — on a phone, where the aside IS the
 * screen, and on the desktop rail alike.
 *
 * It was `tight` on the rail, and that single line spent most of a narrow column
 * on the id and the project chip while truncating the title to a few words. The
 * rail is not short of HEIGHT, so the phone's two-line row is the better trade
 * there too. It is a named constant because `App.tsx` asks the same question of
 * `taskRowsHaveMeta` before polling for what those rows state, and the two
 * answers may not drift.
 */
export const SIDEBAR_BACKLOG_DENSITY: BacklogDensity = "comfortable";

/**
 * Which Backlog VIEW is on screen. One list surface, two orderings that cannot
 * coexist: `backlog` is the hand-arranged tree (manual `sortOrder`, drag to
 * reorder/reparent/reassign — the structure view), `focus` is the self-sorting
 * when-grouped list (`lib/backlogFocus.ts` — the "what do I do next" view).
 * `inbox` is the triage queue for Tasks that ARRIVED rather than being typed
 * (`lib/backlogInbox.ts`). `viewMode` above is the BACKLOG view's own grouping,
 * not a peer of these.
 */
export type BacklogView = "backlog" | "focus" | "inbox";

const BACKLOG_VIEWS: readonly BacklogView[] = ["backlog", "focus", "inbox"];

/** Coerce a persisted/unknown value to a real view, defaulting to the tree. */
export function normalizeBacklogView(value: unknown): BacklogView {
  return BACKLOG_VIEWS.includes(value as BacklogView)
    ? (value as BacklogView)
    : "backlog";
}

export function projectIdForFilter(item: Task): string {
  return item.projectId?.trim() ?? "";
}

export function taskMatchesProjectFilter(
  item: Task,
  filter: BacklogProjectFilter,
): boolean {
  if (filter.kind === "all") return true;
  const projectId = projectIdForFilter(item);
  if (filter.kind === "unassigned") return projectId.length === 0;
  return projectId === filter.projectId;
}

/** A status filter only narrows the list when a strict, non-empty subset is
 * selected; empty or all-three means "show everything". */
export function statusFilterActive(statuses: Iterable<TaskStatus>): boolean {
  const set = statuses instanceof Set ? statuses : new Set(statuses);
  return set.size > 0 && set.size < ALL_STATUSES.length;
}

/**
 * The statuses a view should actually keep, or `null` for "show everything" —
 * the canonical semantics above, generalized to a view that OFFERS only some of
 * the chips.
 *
 * Focus offers todo/doing only, and the persisted set is shared with the other
 * views, so it must be read through that lens: comparing the raw set against
 * all three statuses meant turning both visible chips off produced `{done}` —
 * a strict subset, so "filtering" — and Focus, which never shows done, went
 * blank. Intersecting first makes empty-or-all mean no filter WITHIN the
 * options, which is the same rule the tree view has always had.
 */
export function statusFilterFor(
  statuses: Iterable<TaskStatus>,
  options: readonly TaskStatus[] = ALL_STATUSES,
): Set<TaskStatus> | null {
  const set = statuses instanceof Set ? statuses : new Set(statuses);
  const effective = new Set(options.filter((status) => set.has(status)));
  if (effective.size === 0 || effective.size === options.length) return null;
  return effective;
}

// ── Task hierarchy (Normal view) ────────────────────────────────────────────

function nodesFromFlat(flat: FlatTask[]): BacklogNode[] {
  const roots: BacklogNode[] = [];
  const stack: Array<{ depth: number; node: BacklogNode }> = [];
  for (const entry of flat) {
    const node: BacklogNode = {
      id: entry.item.id,
      data: {
        kind: "task",
        task: entry.item,
        descendantCount: entry.descendantCount,
        doneDescendantCount: entry.doneDescendantCount,
      },
      children: [],
    };
    while (stack.length && stack[stack.length - 1]!.depth >= entry.depth)
      stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) (parent.node.children ??= []).push(node);
    else roots.push(node);
    stack.push({ depth: entry.depth, node });
  }
  return roots;
}

/**
 * Build the nested task hierarchy. Reuses `flattenTasks` so ordering, parent
 * resolution (orphans → root), and cycle-safety match the rest of the Backlog
 * exactly; the pre-order + depth list is then rebuilt into `TreeNode`s.
 */
export function buildTaskNodes(tasks: Task[]): BacklogNode[] {
  return nodesFromFlat(flattenTasks(tasks));
}

// ── Project layer (By Project view) ──────────────────────────────────────────

const PROJECT_NODE_PREFIX = "project::";
const UNASSIGNED_KEY = `${PROJECT_NODE_PREFIX}unassigned`;

export function isProjectNodeKey(id: string): boolean {
  return id.startsWith(PROJECT_NODE_PREFIX);
}

function projectNodeKey(projectId: string | null, known: boolean): string {
  if (projectId === null) return UNASSIGNED_KEY;
  return `${PROJECT_NODE_PREFIX}${known ? "known" : "unknown"}:${projectId}`;
}

/**
 * Build the project-layer tree: project headers (depth 0, collapsible) whose
 * children are that project's tasks (flat — each task grouped by its own
 * `projectId`, mirroring the previous By-Project grouping). Known registry
 * projects are listed first (and kept even when empty under the "all" filter),
 * then unknown/stale project ids, then Unassigned.
 */
export function buildProjectLayerNodes(
  tasks: Task[],
  projectsById: Map<string, ProjectRecord>,
  activeProjects: ProjectRecord[],
  filter: BacklogProjectFilter,
): BacklogNode[] {
  type Group = { node: ProjectNodeData; children: BacklogNode[]; rank: number };
  const groups = new Map<string, Group>();

  const ensureGroup = (projectId: string | null): Group => {
    const known = projectId !== null && projectsById.has(projectId);
    const key = projectNodeKey(projectId, known);
    const existing = groups.get(key);
    if (existing) return existing;
    let data: ProjectNodeData;
    let rank: number;
    if (projectId === null) {
      data = {
        kind: "project",
        key,
        projectId: null,
        label: "Unassigned",
        known: false,
        taskCount: 0,
      };
      rank = 2;
    } else {
      const display = resolveProjectDisplay(projectId, projectsById);
      const color = projectColor(projectsById.get(projectId) ?? projectId);
      data = {
        kind: "project",
        key,
        projectId,
        label: known
          ? display.label
          : `Unknown project: ${display.label || projectId}`,
        known,
        dot: color.dot,
        stripe: color.stripe,
        taskCount: 0,
      };
      rank = known ? 0 : 1;
    }
    const group: Group = { node: data, children: [], rank };
    groups.set(key, group);
    return group;
  };

  // Pre-seed known registry projects so empty groups still show under "all".
  if (filter.kind === "all") {
    for (const project of activeProjects) ensureGroup(project.id);
  }

  // The project layer is the full task tree CUT at project boundaries: each task
  // belongs to its own project's group, and is nested under its parent only while
  // they share a project. A child with a different project "breaks out" and
  // becomes a top-level entry in its own project group (so the full subtask
  // nesting is preserved within a project).
  const fullTree = buildTaskNodes(tasks);
  const groupOf = (node: BacklogNode): string | null =>
    node.data.kind === "task" ? node.data.task.projectId?.trim() || null : null;
  const filterAllows = (group: string | null): boolean => {
    if (filter.kind === "all") return true;
    if (filter.kind === "unassigned") return group === null;
    return group === filter.projectId;
  };
  // Copy a node keeping only descendants in the same project group.
  const cloneSameGroup = (
    node: BacklogNode,
    group: string | null,
  ): BacklogNode => {
    const kids = (node.children ?? [])
      .filter((c) => groupOf(c) === group)
      .map((c) => cloneSameGroup(c, group));
    return kids.length
      ? { id: node.id, data: node.data, children: kids }
      : { id: node.id, data: node.data };
  };
  const visit = (node: BacklogNode, parentGroup: string | null | undefined) => {
    const group = groupOf(node);
    const isGroupRoot = parentGroup === undefined || group !== parentGroup;
    if (isGroupRoot && filterAllows(group))
      ensureGroup(group).children.push(cloneSameGroup(node, group));
    for (const child of node.children ?? []) visit(child, group);
  };
  for (const root of fullTree) visit(root, undefined);

  if (filter.kind === "all") ensureGroup(null); // always offer an Unassigned drop target

  const countTasks = (nodes: BacklogNode[]): number =>
    nodes.reduce((sum, n) => sum + 1 + countTasks(n.children ?? []), 0);

  return [...groups.values()]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.node.label.localeCompare(b.node.label, undefined, {
          sensitivity: "base",
        }),
    )
    .map((group) => ({
      id: group.node.key,
      data: { ...group.node, taskCount: countTasks(group.children) },
      children: group.children,
    }));
}

/**
 * Resolve the project a drop landed on, given the literal drop-target node id
 * (the Tree's `overId`). In the project layer a task's parent IS its project
 * node, so this returns the project node itself when dropped on a header, or the
 * owning project when dropped on one of its tasks. `undefined` if unresolved.
 *
 * Using the drop target (not the depth projection) avoids misattributing the
 * target project when project headers and tasks share one tree.
 */
function resolveDropProject(
  nodes: BacklogNode[],
  overId: string | null,
): { projectId: string | null; label: string } | undefined {
  if (!overId) return undefined;
  const contains = (node: BacklogNode): boolean => {
    for (const child of node.children ?? []) {
      if (child.id === overId || contains(child)) return true;
    }
    return false;
  };
  for (const node of nodes) {
    if (node.data.kind !== "project") continue;
    if (node.id === overId || contains(node))
      return { projectId: node.data.projectId, label: node.data.label };
  }
  return undefined;
}

// ── Status filter pruning (both views) ────────────────────────────────────────

/**
 * Prune a tree (task hierarchy or project layer) to rows matching the status
 * filter, keeping non-matching ancestors as dimmed context so a matching
 * descendant stays reachable. Project header nodes are kept only when they
 * retain at least one task. A no-op when the filter is inactive.
 */
export function filterNodesByStatus(
  nodes: BacklogNode[],
  statuses: Set<TaskStatus>,
): BacklogNode[] {
  if (!statusFilterActive(statuses)) return nodes;
  return pruneNodes(nodes, (task) => statuses.has(task.status));
}

/**
 * Prune the task hierarchy to rows matching the project filter (Normal view),
 * keeping non-matching ancestors as dimmed context. A no-op for the "all" filter.
 */
export function filterNodesByProject(
  nodes: BacklogNode[],
  filter: BacklogProjectFilter,
): BacklogNode[] {
  if (filter.kind === "all") return nodes;
  return pruneNodes(nodes, (task) => taskMatchesProjectFilter(task, filter));
}

/** Shared pruning: keep a task if it matches, or as dimmed `context` when a
 * descendant matches. Project header nodes survive only with surviving tasks. */
function pruneNodes(
  nodes: BacklogNode[],
  matches: (task: Task) => boolean,
): BacklogNode[] {
  const prune = (list: BacklogNode[]): BacklogNode[] => {
    const out: BacklogNode[] = [];
    for (const node of list) {
      const kids = node.children ? prune(node.children) : [];
      if (node.data.kind === "project") {
        if (kids.length) out.push({ ...node, children: kids });
        continue;
      }
      if (matches(node.data.task)) {
        out.push(
          kids.length
            ? { ...node, children: kids }
            : { id: node.id, data: node.data },
        );
      } else if (kids.length) {
        out.push({
          ...node,
          data: { ...node.data, context: true },
          children: kids,
        });
      }
    }
    return out;
  };
  return prune(nodes);
}

// ── Tree → app placement adapters ─────────────────────────────────────────────

export type TaskPlacement = { id: string; parentId?: string | null };

/** Flatten a (task-only) tree into pre-order `{id, parentId}` placements for
 * `reorderTasks`. */
function placementsFromNodes(nodes: BacklogNode[]): TaskPlacement[] {
  const out: TaskPlacement[] = [];
  const walk = (list: BacklogNode[], parentId: string | null) => {
    for (const node of list) {
      out.push({ id: node.id, parentId });
      if (node.children?.length) walk(node.children, node.id);
    }
  };
  walk(nodes, null);
  return out;
}

function childrenIdsOf(
  nodes: BacklogNode[],
  parentId: string | null,
): string[] {
  if (parentId == null) return nodes.map((n) => n.id);
  const find = (list: BacklogNode[]): string[] | null => {
    for (const node of list) {
      if (node.id === parentId) return (node.children ?? []).map((c) => c.id);
      if (node.children) {
        const found = find(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  return find(nodes) ?? [];
}

/**
 * Reconstruct full `{id,parentId}` placements for a Normal-view drag, so reorder
 * works even when a filter hides rows. The Tree's move is expressed against the
 * VISIBLE (pruned) tree; we re-apply it to the FULL task tree, anchoring the
 * moved node(s) immediately after their visible predecessor under the new parent.
 * Filtered-out tasks keep their place. Works unfiltered too (visible == full).
 */
export function reorderPlacements(
  ordered: Task[],
  result: {
    id: string;
    ids: string[];
    parentId: string | null;
    items: BacklogNode[];
  },
): TaskPlacement[] {
  const fullTree = buildTaskNodes(ordered);
  const roots = result.ids.length > 0 ? result.ids : [result.id];
  const anchor = roots[0]!;

  // The visible sibling immediately before the moved node under the new parent.
  const visibleSibs = childrenIdsOf(result.items, result.parentId);
  const anchorPos = visibleSibs.indexOf(anchor);
  const afterId = anchorPos > 0 ? visibleSibs[anchorPos - 1]! : null;

  // Translate that anchor to an insertion index among the new parent's full
  // children (excluding the moved roots, which extraction removes first).
  const movedSet = new Set(roots);
  const fullSibs = childrenIdsOf(fullTree, result.parentId).filter(
    (id) => !movedSet.has(id),
  );
  const index =
    afterId == null ? 0 : Math.max(0, fullSibs.indexOf(afterId) + 1);

  const newTree =
    roots.length > 1
      ? applyGroupMove(fullTree, roots, result.parentId, index)
      : applyMove(fullTree, { id: anchor, parentId: result.parentId, index });
  return placementsFromNodes(newTree);
}

/** Find the children id list of a node within a (possibly nested) tree. */
function childrenIdsAtNode(nodes: BacklogNode[], nodeId: string): string[] {
  const find = (list: BacklogNode[]): string[] | null => {
    for (const node of list) {
      if (node.id === nodeId) return (node.children ?? []).map((c) => c.id);
      if (node.children) {
        const found = find(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  return find(nodes) ?? [];
}

/** The project node id whose subtree (in the project layer) the task `taskId` sits directly under at top level — i.e. the group fragment's project node. */
function projectNodeContaining(
  nodes: BacklogNode[],
  taskId: string,
): BacklogNode | null {
  const contains = (node: BacklogNode): boolean =>
    (node.children ?? []).some((c) => c.id === taskId || contains(c));
  for (const node of nodes) {
    if (node.data.kind === "project" && contains(node)) return node;
  }
  return null;
}

export type ProjectViewDrop = {
  placements: TaskPlacement[];
  targetProjectId: string | null;
  targetLabel: string;
};

/**
 * Resolve a drag in the (now nested) project-layer view into a full reorder.
 * The Tree's projection gives the new parent — a project node (drop at the top
 * level of that project) or a task node (drop as a subtask). We translate that
 * into a real-parent + position move on the full task tree, and report the
 * target project so the caller can also reassign `projectId` when it changed.
 */
export function projectViewDrop(
  ordered: Task[],
  nodes: BacklogNode[],
  projectsById: Map<string, ProjectRecord>,
  result: {
    id: string;
    ids: string[];
    parentId: string | null;
    overId: string | null;
    items: BacklogNode[];
  },
): ProjectViewDrop | null {
  const roots = result.ids.length > 0 ? result.ids : [result.id];
  const anchor = roots[0]!;
  const pid = result.parentId;

  // Real parent task (null = top level of a project) + the target project.
  let realParentId: string | null;
  let targetProjectId: string | null;
  if (pid && isProjectNodeKey(pid)) {
    const info = resolveDropProject(nodes, pid);
    if (!info) return null;
    realParentId = null;
    targetProjectId = info.projectId;
  } else if (pid) {
    const parentTask = ordered.find((t) => t.id === pid);
    if (!parentTask) return null;
    realParentId = pid;
    targetProjectId = parentTask.projectId?.trim() || null;
  } else {
    const info = resolveDropProject(nodes, result.overId);
    if (!info) return null;
    realParentId = null;
    targetProjectId = info.projectId;
  }

  // New-order siblings under the drop parent (a project node when top level).
  let sibIds: string[];
  if (realParentId == null) {
    const projectNode =
      projectNodeContaining(result.items, anchor) ??
      (pid && isProjectNodeKey(pid)
        ? (result.items.find((n) => n.id === pid) ?? null)
        : null);
    sibIds = projectNode ? (projectNode.children ?? []).map((c) => c.id) : [];
  } else {
    sibIds = childrenIdsAtNode(result.items, realParentId);
  }
  const pos = sibIds.indexOf(anchor);
  const before = pos > 0 ? sibIds[pos - 1]! : null;

  const movedSet = new Set(roots);
  const fullTree = buildTaskNodes(ordered);
  const fullSibs = childrenIdsOf(fullTree, realParentId).filter(
    (id) => !movedSet.has(id),
  );
  const index = before ? Math.max(0, fullSibs.indexOf(before) + 1) : 0;

  const newTree =
    roots.length > 1
      ? applyGroupMove(fullTree, roots, realParentId, index)
      : applyMove(fullTree, { id: anchor, parentId: realParentId, index });

  const targetLabel =
    targetProjectId == null
      ? "Unassigned"
      : resolveProjectDisplay(targetProjectId, projectsById).label ||
        targetProjectId;

  return {
    placements: placementsFromNodes(newTree),
    targetProjectId,
    targetLabel,
  };
}

/** Collect ids of nodes that have children (used to seed default-expanded). */
export function collectExpandableIds(nodes: BacklogNode[]): string[] {
  const out: string[] = [];
  const walk = (list: BacklogNode[]) => {
    for (const node of list) {
      if (node.children?.length) {
        out.push(node.id);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}
