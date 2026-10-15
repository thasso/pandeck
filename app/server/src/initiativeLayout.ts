/**
 * The Initiative map's layout (`docs/initiatives.md`, Layout and placement):
 * where every member, outside blocker and `blocks` arrow is drawn, computed
 * with elkjs in a worker thread (`initiativeLayoutRunner.ts`).
 *
 * The map reads left to right along `blocks`. Each member root epic has a
 * lane, the lanes of one Project sit together, an outside blocker is a stub in
 * the first column of the lane it blocks into, and the milestones stand in a
 * column of their own to the right of every lane. A collapsed epic is one node
 * standing for its subtree; milestones under it stay drawn.
 *
 * The layout reads ONLY the graph's structure ({@link LayoutStructure}): the
 * members in order, their hierarchy, each root's Project, the milestone marks
 * and the `blocks` links. Status, title, blocked and archived state are not in
 * it, so a status change keeps the layout, and the cache key is a digest of
 * exactly what the layout read. Nothing here runs from a write or an event
 * flush: a layout is computed when a map is read, and the read re-checks the
 * structure after the wait, so an answer never pairs a graph with a layout of
 * another one.
 */
import { createHash } from "node:crypto";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type {
  InitiativeDetail,
  InitiativeGraphNode,
  InitiativeLayout,
  InitiativeLayoutBox,
  InitiativeLayoutEdge,
  InitiativeLayoutGroup,
  InitiativeLayoutLane,
  InitiativeLayoutNode,
  InitiativeLayoutPoint,
} from "@assistant/shared";
import {
  initiativeProgressOf,
  initiativeRevision,
  readInitiative,
} from "./initiatives.ts";
import { runElkLayout } from "./initiativeLayoutRunner.ts";

/** Bumped whenever the drawing changes for the same structure. */
const LAYOUT_VERSION = 1;

const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;
const ROW_GAP = 32;
const COLUMN_GAP = 96;
const LANE_HEADER = 36;
const LANE_PAD = 16;
const LANE_GAP = 24;
const GROUP_HEADER = 32;
const GROUP_PAD = 12;
const GROUP_GAP = 40;
const MARGIN = 24;
const ROW_PITCH = NODE_HEIGHT + ROW_GAP;
const COLUMN_PITCH = NODE_WIDTH + COLUMN_GAP;

/** Routing passes that may move lanes apart before the last one stands. */
const ROUTING_ROUNDS = 6;
/** Beyond this many drawn nodes the map asks for collapsed epics instead. */
const MAX_LAYOUT_NODES = 1_000;
/** Layouts kept, across Initiatives and collapsed sets, least recent out. */
const CACHE_LIMIT = 64;
/** Reads that found the structure changed under them before giving up. */
const MAX_ATTEMPTS = 3;

const MILESTONE_REGION = "milestones";

/* ------------------------------- structure ------------------------------- */

interface StructureNode {
  id: string;
  parentId?: string;
  /** Kept only on a root: a lane's Project groups it. */
  projectId?: string;
  milestone?: true;
}

/** Everything the layout reads, and nothing more: its digest is the key. */
interface LayoutStructure {
  version: number;
  rootIds: string[];
  /** Depth-first from the roots, as the graph read orders them. */
  nodes: StructureNode[];
  milestoneIds: string[];
  /** `[from, to]`, deduplicated and sorted, so link creation order is not in it. */
  edges: Array<[string, string]>;
}

function structureOf(detail: InitiativeDetail): LayoutStructure {
  const roots = new Set(detail.rootIds);
  const edges = new Map<string, [string, string]>();
  for (const edge of detail.edges)
    edges.set(`${edge.from}>${edge.to}`, [edge.from, edge.to]);
  return {
    version: LAYOUT_VERSION,
    rootIds: detail.rootIds,
    nodes: detail.nodes.map((node) => ({
      id: node.id,
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      ...(roots.has(node.id) && node.projectId
        ? { projectId: node.projectId }
        : {}),
      ...(node.milestone ? { milestone: true as const } : {}),
    })),
    milestoneIds: detail.milestoneIds,
    edges: [...edges.values()].sort(
      (a, b) => compareIds(a[1], b[1]) || compareIds(a[0], b[0]),
    ),
  };
}

function compareIds(a: string, b: string): number {
  return Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/* --------------------------------- plan ---------------------------------- */

interface PlanNode {
  id: string;
  kind: InitiativeLayoutNode["kind"];
  taskId: string;
  laneId?: string;
  milestone?: true;
  hiddenTaskIds?: string[];
}

/** What is drawn: the visible nodes in model order, lanes, groups, arrows. */
interface LayoutPlan {
  groups: Array<{ projectId?: string; laneIds: string[] }>;
  lanes: Array<{ id: string; projectId?: string }>;
  nodes: PlanNode[];
  edges: Array<[string, string]>;
}

interface LayoutTarget {
  structureKey: string;
  /** Identity of the drawing: the structure and the applied collapsed set. */
  key: string;
  collapsed: string[];
  plan: LayoutPlan;
  /** Set when the plan is too large to lay out. */
  error?: string;
}

function layoutTarget(
  detail: InitiativeDetail,
  requested: readonly string[],
): LayoutTarget {
  const structure = structureOf(detail);
  const structureKey = digest(JSON.stringify(structure));
  const collapsed = appliedCollapse(structure, requested);
  const plan = planOf(structure, collapsed);
  return {
    structureKey,
    key: digest(`${structureKey}|${collapsed.join(",")}`),
    collapsed,
    plan,
    ...(plan.nodes.length > MAX_LAYOUT_NODES
      ? {
          error: `The map has ${plan.nodes.length} nodes, more than the ${MAX_LAYOUT_NODES} it lays out; collapse epics to draw it.`,
        }
      : {}),
  };
}

/** Each of `id`'s member ancestors, nearest first; a stored cycle ends the walk. */
function ancestorsOf(
  parent: ReadonlyMap<string, string | undefined>,
  id: string,
): string[] {
  const seen = new Set([id]);
  const result: string[] = [];
  for (let at = parent.get(id); at !== undefined; at = parent.get(at)) {
    if (seen.has(at)) break;
    seen.add(at);
    result.push(at);
  }
  return result;
}

/**
 * The requested epics that collapse anything: a member with member children,
 * not under another collapsed one. Ascending by id, so equal sets are one key.
 */
function appliedCollapse(
  structure: LayoutStructure,
  requested: readonly string[],
): string[] {
  const parent = new Map(
    structure.nodes.map((node) => [node.id, node.parentId]),
  );
  const parents = new Set(
    structure.nodes.flatMap((node) =>
      node.parentId !== undefined ? [node.parentId] : [],
    ),
  );
  const wanted = new Set(requested.filter((id) => parents.has(id)));
  return [...wanted]
    .filter((id) => !ancestorsOf(parent, id).some((up) => wanted.has(up)))
    .sort(compareIds);
}

function planOf(
  structure: LayoutStructure,
  collapsed: readonly string[],
): LayoutPlan {
  const parent = new Map(
    structure.nodes.map((node) => [node.id, node.parentId]),
  );
  const byId = new Map(structure.nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of structure.nodes) {
    if (node.parentId === undefined) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }

  // Lanes follow the graph read: depth-first from each root in the user's
  // order; only a stored hierarchy cycle leaves a member for a lane of its own.
  const laneRootOf = new Map<string, string>();
  const laneRoots: string[] = [];
  const claim = (root: string, id: string): void => {
    if (laneRootOf.has(id)) return;
    laneRootOf.set(id, root);
    for (const child of children.get(id) ?? []) claim(root, child);
  };
  for (const root of [
    ...structure.rootIds,
    ...structure.nodes.map((node) => node.id),
  ]) {
    if (!byId.has(root) || laneRootOf.has(root)) continue;
    laneRoots.push(root);
    claim(root, root);
  }

  const collapsedSet = new Set(collapsed);
  const representative = (id: string): string => {
    if (byId.get(id)?.milestone) return id;
    let rep = id;
    for (const up of [id, ...ancestorsOf(parent, id)])
      if (collapsedSet.has(up)) rep = up;
    return rep;
  };

  const visible = new Map<string, PlanNode>();
  const hidden = new Map<string, string[]>();
  for (const node of structure.nodes) {
    const rep = representative(node.id);
    if (rep !== node.id) {
      const list = hidden.get(rep) ?? [];
      list.push(node.id);
      hidden.set(rep, list);
      continue;
    }
    visible.set(node.id, {
      id: node.id,
      kind: collapsedSet.has(node.id) ? "collapsed" : "task",
      taskId: node.id,
      ...(node.milestone
        ? { milestone: true as const }
        : { laneId: laneRootOf.get(node.id)! }),
    });
  }
  for (const [id, hiddenTaskIds] of hidden)
    visible.get(id)!.hiddenTaskIds = hiddenTaskIds;

  const stubs = new Map<string, PlanNode>();
  const edges = new Map<string, [string, string]>();
  for (const [from, to] of structure.edges) {
    const target = visible.get(representative(to));
    if (!target) continue;
    let source: string;
    if (byId.has(from)) {
      source = representative(from);
    } else {
      source = `external:${from}:${target.laneId ?? MILESTONE_REGION}`;
      if (!stubs.has(source))
        stubs.set(source, {
          id: source,
          kind: "external",
          taskId: from,
          ...(target.laneId !== undefined ? { laneId: target.laneId } : {}),
        });
    }
    if (source === target.id) continue;
    edges.set(`${source}>${target.id}`, [source, target.id]);
  }

  const lanes = laneRoots
    .filter((root) =>
      [...visible.values()].some((node) => node.laneId === root),
    )
    .map((root) => {
      const projectId = byId.get(root)?.projectId;
      return { id: root, ...(projectId ? { projectId } : {}) };
    });
  const groups: LayoutPlan["groups"] = [];
  for (const lane of lanes) {
    const group = groups.find((entry) => entry.projectId === lane.projectId);
    if (group) group.laneIds.push(lane.id);
    else
      groups.push({
        ...(lane.projectId ? { projectId: lane.projectId } : {}),
        laneIds: [lane.id],
      });
  }
  const orderedLanes = groups.flatMap((group) =>
    group.laneIds.map((id) => lanes.find((lane) => lane.id === id)!),
  );

  const stubsIn = (laneId: string | undefined): PlanNode[] =>
    [...stubs.values()]
      .filter((stub) => stub.laneId === laneId)
      .sort((a, b) => compareIds(a.taskId, b.taskId));
  const milestoneOrder = new Map(
    structure.milestoneIds.map((id, index) => [id, index]),
  );
  const nodes: PlanNode[] = [
    ...orderedLanes.flatMap((lane) => [
      ...stubsIn(lane.id),
      ...[...visible.values()].filter((node) => node.laneId === lane.id),
    ]),
    ...stubsIn(undefined),
    ...[...visible.values()]
      .filter((node) => node.milestone)
      .sort(
        (a, b) =>
          (milestoneOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (milestoneOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      ),
  ];
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  return {
    groups,
    lanes: orderedLanes,
    nodes,
    edges: [...edges.values()].sort(
      (a, b) =>
        order.get(a[1])! - order.get(b[1])! ||
        order.get(a[0])! - order.get(b[0])!,
    ),
  };
}

/* -------------------------------- geometry ------------------------------- */

// One graph, never split into connected components: ELK would lay each out
// and pack them on its own, so columns would no longer line up across lanes.
const LAYERING_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.separateConnectedComponents": "false",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.spacing.nodeNode": String(ROW_GAP),
  "elk.layered.spacing.nodeNodeBetweenLayers": String(COLUMN_GAP),
};

// The second pass keeps the columns and rows the first one planned (every
// strategy reads the given positions) and routes the arrows around them.
const ROUTING_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.separateConnectedComponents": "false",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
  "elk.layered.layering.strategy": "INTERACTIVE",
  "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
  "elk.layered.nodePlacement.strategy": "INTERACTIVE",
  "elk.spacing.nodeNode": String(ROW_GAP / 2),
  "elk.layered.spacing.nodeNodeBetweenLayers": String(COLUMN_GAP),
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

function elkEdges(edges: ReadonlyArray<[string, string]>): ElkExtendedEdge[] {
  return edges.map(([from, to], index) => ({
    id: `e${index}`,
    sources: [from],
    targets: [to],
  }));
}

/**
 * Two ELK passes. The first lays out the lanes' nodes as one graph, which
 * gives every node a column (its layer) and an order inside it; stubs take a
 * first column of their own. The rows are then planned here: each lane is a
 * band as tall as its fullest column, the bands stacked by Project, and the
 * milestones and their stubs placed in the columns after the last lane column,
 * level with what blocks them. The second pass keeps those positions and
 * routes every arrow orthogonally; it runs again, a few times at most, while a
 * lane needs more room than its rows were given.
 */
async function computeLayout(target: LayoutTarget): Promise<InitiativeLayout> {
  const { plan } = target;
  const empty: InitiativeLayout = {
    key: target.key,
    collapsed: target.collapsed,
    width: 2 * MARGIN,
    height: 2 * MARGIN,
    groups: [],
    lanes: [],
    nodes: [],
    edges: [],
  };
  if (plan.nodes.length === 0) return empty;
  const order = new Map(plan.nodes.map((node, index) => [node.id, index]));
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const inLane = plan.nodes.filter((node) => node.laneId !== undefined);
  const laneIds = new Set(inLane.map((node) => node.id));

  // Pass 1: columns and in-column order of the lanes' nodes.
  const column = new Map<string, number>();
  const firstY = new Map<string, number>();
  let laneColumns = 0;
  if (inLane.length > 0) {
    const layered = await runElkLayout({
      id: "root",
      layoutOptions: LAYERING_OPTIONS,
      children: inLane.map((node) => ({
        id: node.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ...(node.kind === "external"
          ? {
              layoutOptions: {
                "elk.layered.layering.layerConstraint": "FIRST_SEPARATE",
              },
            }
          : {}),
      })),
      edges: elkEdges(
        plan.edges.filter(([from, to]) => laneIds.has(from) && laneIds.has(to)),
      ),
    });
    const xs = [
      ...new Set(
        (layered.children ?? []).map((child) => Math.round(child.x ?? 0)),
      ),
    ].sort((a, b) => a - b);
    for (const child of layered.children ?? []) {
      column.set(child.id, xs.indexOf(Math.round(child.x ?? 0)));
      firstY.set(child.id, child.y ?? 0);
    }
    laneColumns = xs.length;
  }

  // Rows: each lane a band, stacked by Project.
  const hintY = new Map<string, number>();
  let top = 0;
  for (const group of plan.groups) {
    top += GROUP_HEADER;
    for (const laneId of group.laneIds) {
      const byColumn = new Map<number, PlanNode[]>();
      for (const node of inLane) {
        if (node.laneId !== laneId) continue;
        const at = column.get(node.id)!;
        const list = byColumn.get(at) ?? [];
        list.push(node);
        byColumn.set(at, list);
      }
      let rows = 1;
      const firstRow = top + LANE_HEADER;
      for (const list of byColumn.values()) {
        list.sort(
          (a, b) =>
            firstY.get(a.id)! - firstY.get(b.id)! ||
            order.get(a.id)! - order.get(b.id)!,
        );
        list.forEach((node, slot) =>
          hintY.set(node.id, firstRow + slot * ROW_PITCH),
        );
        rows = Math.max(rows, list.length);
      }
      const bottom = firstRow + rows * ROW_PITCH - ROW_GAP + LANE_PAD;
      top = bottom + LANE_GAP;
    }
    top += GROUP_PAD + GROUP_GAP - LANE_GAP;
  }

  // The milestone column(s): stubs first, then milestones by their depth
  // along milestone-to-milestone arrows, each level with what blocks it.
  const regionStubs = plan.nodes.filter(
    (node) => node.laneId === undefined && node.kind === "external",
  );
  const milestones = plan.nodes.filter(
    (node) => node.laneId === undefined && node.kind !== "external",
  );
  const milestoneBase = laneColumns + (regionStubs.length > 0 ? 1 : 0);
  const milestoneIds = new Set(milestones.map((node) => node.id));
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    onPath.add(id);
    let value = 0;
    for (const [from, to] of plan.edges)
      if (to === id && milestoneIds.has(from) && !onPath.has(from))
        value = Math.max(value, depthOf(from) + 1);
    onPath.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const node of milestones)
    column.set(node.id, milestoneBase + depthOf(node.id));
  for (const node of regionStubs) column.set(node.id, laneColumns);

  // Lanes move down when a routing round finds them too close (below).
  const laneShift = new Map<string, number>();
  const plannedY = (node: PlanNode): number =>
    hintY.get(node.id)! +
    (node.laneId !== undefined ? (laneShift.get(node.laneId) ?? 0) : 0);

  const regionTop = GROUP_HEADER + LANE_HEADER;
  const center = (id: string): number | undefined => {
    const node = byId.get(id);
    return node && hintY.has(id) ? plannedY(node) + NODE_HEIGHT / 2 : undefined;
  };
  const place = (nodes: PlanNode[], neighbours: (id: string) => string[]) => {
    const desired = new Map<string, number>();
    for (const node of nodes) {
      const centers = neighbours(node.id).flatMap((id) => {
        const y = center(id);
        return y === undefined ? [] : [y];
      });
      if (centers.length > 0)
        desired.set(
          node.id,
          centers.reduce((sum, y) => sum + y, 0) / centers.length,
        );
    }
    const sorted = [...nodes].sort(
      (a, b) =>
        (desired.get(a.id) ?? Infinity) - (desired.get(b.id) ?? Infinity) ||
        order.get(a.id)! - order.get(b.id)!,
    );
    let cursor = regionTop;
    for (const node of sorted) {
      const wish = desired.get(node.id);
      const y = Math.max(
        cursor,
        wish === undefined ? cursor : Math.round(wish - NODE_HEIGHT / 2),
      );
      hintY.set(node.id, y);
      cursor = y + ROW_PITCH;
    }
  };
  const milestoneColumns = [
    ...new Set(milestones.map((node) => column.get(node.id)!)),
  ].sort((a, b) => a - b);
  const placeMilestones = () => {
    for (const at of milestoneColumns)
      place(
        milestones.filter((node) => column.get(node.id) === at),
        (id) => plan.edges.filter(([, to]) => to === id).map(([from]) => from),
      );
    place(regionStubs, (id) =>
      plan.edges.filter(([from]) => from === id).map(([, to]) => to),
    );
  };

  // Pass 2: keep the planned positions, route the arrows. ELK moves a node
  // down where an arrow has to pass through its row, which can carry it into
  // the next lane's band in that column; the lanes below then move down by
  // what is missing, and the arrows are routed again.
  const laneOrder = plan.lanes.map((lane) => lane.id);
  let box = new Map<string, InitiativeLayoutBox>();
  let routed: ElkNode = { id: "root" };
  for (let round = 1; round <= ROUTING_ROUNDS; round += 1) {
    placeMilestones();
    routed = await runElkLayout({
      id: "root",
      layoutOptions: ROUTING_OPTIONS,
      children: plan.nodes.map((node) => ({
        id: node.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        x: column.get(node.id)! * COLUMN_PITCH,
        y: plannedY(node),
      })),
      edges: elkEdges(plan.edges),
    });
    box = new Map();
    for (const child of routed.children ?? [])
      box.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    if (round === ROUTING_ROUNDS) break;
    const extent = (laneId: string, y: (id: string) => number) => {
      const ys = inLane
        .filter((node) => node.laneId === laneId)
        .map((node) => y(node.id));
      return { top: Math.min(...ys), bottom: Math.max(...ys) + NODE_HEIGHT };
    };
    let carried = 0;
    for (const [index, lower] of laneOrder.entries()) {
      if (index === 0) continue;
      const upper = laneOrder[index - 1]!;
      const gap = (y: (id: string) => number) =>
        extent(lower, y).top - extent(upper, y).bottom;
      // What the rows need, unshifted, against what this round drew. Moving a
      // lane moves the arrows into it too, so a short gap gets a row gap more
      // than it lacks: the next round rarely finds it short again.
      const missing = Math.ceil(
        gap((id) => hintY.get(id)!) - gap((id) => box.get(id)!.y),
      );
      if (missing > 0) carried += missing + ROW_GAP;
      if (carried > 0)
        laneShift.set(lower, (laneShift.get(lower) ?? 0) + carried);
    }
    if (carried === 0) break;
  }

  const unionOf = (ids: readonly string[]) => {
    const boxes = ids.map((id) => box.get(id)!);
    return {
      left: Math.min(...boxes.map((b) => b.x)),
      right: Math.max(...boxes.map((b) => b.x + b.width)),
      top: Math.min(...boxes.map((b) => b.y)),
      bottom: Math.max(...boxes.map((b) => b.y + b.height)),
    };
  };

  const lanes: InitiativeLayoutLane[] = [];
  const groups: InitiativeLayoutGroup[] = [];
  if (inLane.length > 0) {
    const across = unionOf(inLane.map((node) => node.id));
    const left = across.left - LANE_PAD;
    const right = across.right + LANE_PAD;
    for (const group of plan.groups) {
      const groupLanes = group.laneIds.map((laneId) => {
        const extent = unionOf(
          inLane
            .filter((node) => node.laneId === laneId)
            .map((node) => node.id),
        );
        const projectId = plan.lanes.find(
          (lane) => lane.id === laneId,
        )?.projectId;
        const lane: InitiativeLayoutLane = {
          id: laneId,
          ...(projectId ? { projectId } : {}),
          x: left,
          y: extent.top - LANE_HEADER,
          width: right - left,
          height: extent.bottom + LANE_PAD - (extent.top - LANE_HEADER),
        };
        return lane;
      });
      lanes.push(...groupLanes);
      const first = groupLanes[0]!;
      const last = groupLanes[groupLanes.length - 1]!;
      groups.push({
        ...(group.projectId ? { projectId: group.projectId } : {}),
        laneIds: group.laneIds,
        x: left - GROUP_PAD,
        y: first.y - GROUP_HEADER,
        width: right - left + 2 * GROUP_PAD,
        height: last.y + last.height + GROUP_PAD - (first.y - GROUP_HEADER),
      });
    }
  }
  let milestoneColumn: InitiativeLayoutBox | undefined;
  const region = [...regionStubs, ...milestones].map((node) => node.id);
  if (region.length > 0) {
    const extent = unionOf(region);
    const top = Math.min(
      extent.top - LANE_HEADER,
      ...groups.map((group) => group.y),
    );
    const bottom = Math.max(
      extent.bottom + LANE_PAD,
      ...groups.map((group) => group.y + group.height),
    );
    milestoneColumn = {
      x: extent.left - LANE_PAD,
      y: top,
      width: extent.right - extent.left + 2 * LANE_PAD,
      height: bottom - top,
    };
  }

  const routes = new Map(
    (routed.edges ?? []).map((edge) => {
      const section = edge.sections?.[0];
      const points: InitiativeLayoutPoint[] = section
        ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        : [];
      return [edge.id, points];
    }),
  );
  const edges: InitiativeLayoutEdge[] = plan.edges.map(([from, to], index) => ({
    from,
    to,
    points: routes.get(`e${index}`) ?? [],
  }));

  // Shift everything to start at the margin, then settle on whole pixels.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of [
    ...box.values(),
    ...lanes,
    ...groups,
    ...(milestoneColumn ? [milestoneColumn] : []),
  ]) {
    xs.push(b.x, b.x + b.width);
    ys.push(b.y, b.y + b.height);
  }
  for (const edge of edges)
    for (const point of edge.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
  const dx = MARGIN - Math.min(...xs);
  const dy = MARGIN - Math.min(...ys);
  const shift = <T extends InitiativeLayoutBox>(b: T): T => ({
    ...b,
    x: Math.round(b.x + dx),
    y: Math.round(b.y + dy),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });

  return {
    key: target.key,
    collapsed: target.collapsed,
    width: Math.round(Math.max(...xs) + dx + MARGIN),
    height: Math.round(Math.max(...ys) + dy + MARGIN),
    groups: groups.map(shift),
    lanes: lanes.map(shift),
    ...(milestoneColumn ? { milestoneColumn: shift(milestoneColumn) } : {}),
    nodes: plan.nodes.map((node) =>
      shift({ ...byId.get(node.id)!, ...box.get(node.id)! }),
    ),
    edges: edges.map((edge) => ({
      ...edge,
      points: orthogonalPoints(edge.points, dx, dy),
    })),
  };
}

/**
 * Whole-pixel points that stay orthogonal: ELK's coordinates can differ in the
 * last float digit along a straight segment, which rounding alone could turn
 * into a diagonal. A repeated point is dropped.
 */
function orthogonalPoints(
  points: readonly InitiativeLayoutPoint[],
  dx: number,
  dy: number,
): InitiativeLayoutPoint[] {
  const result: InitiativeLayoutPoint[] = [];
  for (const [index, point] of points.entries()) {
    const next = { x: Math.round(point.x + dx), y: Math.round(point.y + dy) };
    const previous = result[result.length - 1];
    if (previous && next.x !== previous.x && next.y !== previous.y) {
      const raw = points[index - 1]!;
      if (Math.abs(point.x - raw.x) < Math.abs(point.y - raw.y))
        next.x = previous.x;
      else next.y = previous.y;
    }
    if (previous && next.x === previous.x && next.y === previous.y) continue;
    result.push(next);
  }
  return result;
}

/* ------------------------------ cache, reads ----------------------------- */

type Outcome = { layout: InitiativeLayout } | { error: string };

interface CacheEntry {
  initiativeId: string;
  structureKey: string;
  outcome: Promise<Outcome>;
}

/**
 * Layouts by Initiative and drawing key, least recently read first. An entry
 * is the promise, so concurrent reads of one key share one computation. A
 * failure is kept like a result: the input is deterministic, so it would fail
 * again. A read that sees a new structure drops the Initiative's older ones.
 */
const cache = new Map<string, CacheEntry>();

function layoutOf(
  initiativeId: string,
  target: LayoutTarget,
): Promise<Outcome> {
  if (target.error) return Promise.resolve({ error: target.error });
  for (const [key, entry] of cache)
    if (
      entry.initiativeId === initiativeId &&
      entry.structureKey !== target.structureKey
    )
      cache.delete(key);
  const cacheKey = `${initiativeId}:${target.key}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit.outcome;
  }
  const outcome = computeLayout(target).then(
    (layout): Outcome => ({ layout }),
    (err: unknown): Outcome => ({
      error: `The map could not be laid out: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  cache.set(cacheKey, {
    initiativeId,
    structureKey: target.structureKey,
    outcome,
  });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return outcome;
}

function forget(initiativeId: string): void {
  for (const [key, entry] of cache)
    if (entry.initiativeId === initiativeId) cache.delete(key);
}

export interface InitiativeMapRead {
  item: InitiativeDetail | null;
  revision?: number;
  layout?: InitiativeLayout;
  layoutError?: string;
}

/**
 * One Initiative with its graph and the layout that draws exactly that graph.
 * The layout is awaited off the event loop; afterwards the graph is read
 * again, so the answer is as fresh as its sending, and a structure that moved
 * meanwhile is laid out anew (a status change does not move it). A layout that
 * fails leaves the graph in the answer, with the reason.
 */
export async function readInitiativeMap(
  id: string,
  collapsed: readonly string[] = [],
): Promise<InitiativeMapRead> {
  for (let attempt = 1; ; attempt += 1) {
    const before = readInitiative(id);
    if (!before) {
      forget(id.trim());
      return { item: null };
    }
    const target = layoutTarget(before, collapsed);
    const outcome = await layoutOf(before.id, target);
    const item = readInitiative(before.id);
    if (!item) {
      forget(before.id);
      return { item: null };
    }
    const revision = initiativeRevision(item.id);
    const base = { item, ...(revision !== undefined ? { revision } : {}) };
    if (layoutTarget(item, collapsed).key === target.key)
      return "error" in outcome
        ? { ...base, layoutError: outcome.error }
        : { ...base, layout: withProgress(outcome.layout, item) };
    if (attempt === MAX_ATTEMPTS)
      return {
        ...base,
        layoutError:
          "The map kept changing while it was laid out; read it again.",
      };
  }
}

/** A collapsed epic's counts over its descendants, from this read's statuses. */
function withProgress(
  layout: InitiativeLayout,
  detail: InitiativeDetail,
): InitiativeLayout {
  if (layout.collapsed.length === 0) return layout;
  const children = new Map<string, InitiativeGraphNode[]>();
  for (const node of detail.nodes) {
    if (node.parentId === undefined) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const descendants = (id: string): InitiativeGraphNode[] => {
    const result: InitiativeGraphNode[] = [];
    const seen = new Set([id]);
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      result.push(node);
      stack.push(...(children.get(node.id) ?? []));
    }
    return result;
  };
  return {
    ...layout,
    nodes: layout.nodes.map((node) =>
      node.kind === "collapsed"
        ? {
            ...node,
            progress: initiativeProgressOf(
              descendants(node.taskId),
              (member) => member.blocked === true,
            ),
          }
        : node,
    ),
  };
}
