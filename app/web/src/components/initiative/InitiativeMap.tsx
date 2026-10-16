import { memo, useCallback, useMemo, useRef, type FocusEvent } from "react";
import {
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useStoreApi,
  type Edge,
  type ReactFlowInstance,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "./InitiativeMap.css";
import { Flag, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import type {
  InitiativeLayout,
  InitiativeLayoutEdge,
  InitiativeLayoutNode,
} from "@assistant/shared";
import { Item } from "../ui/item.tsx";
import { IconButton } from "../common/IconButton.tsx";
import { TaskStatusIcon } from "../TaskStatusIcon.tsx";
import {
  InitiativeStateMarks,
  memberBandClass,
} from "./InitiativeStateMarks.tsx";
import { TaskIdBadge } from "../TaskIdBadge.tsx";
import {
  memberStateLabel,
  type InitiativeMember,
} from "../../lib/initiativeView.ts";

/**
 * @component InitiativeMap
 * @purpose The Initiative page's Map view: every member Task at the box the
 *   server laid out, its `blocks` arrows along the server's orthogonal routes,
 *   lanes grouped by Project, outside blockers as stubs and milestones in their
 *   own column (`docs/initiatives.md`).
 * @useWhen Lazily, from `InitiativeDetailPage`, once a read carries `layout`.
 * @intent Read-only. It computes no geometry and writes nothing: no drag, no
 *   connect, no edit. Status, blocked and running markers come from `members`,
 *   which the live Tasks topic updates, so a status change recolours a node
 *   without a read or a layout. A node is a real button: Tab walks the Tasks in
 *   lane order and Enter opens one in the object panel. Lanes, Project groups
 *   and the milestone column are drawing, not Tasks, and take no input.
 */

type TaskNodeData = {
  layoutNode: InitiativeLayoutNode;
  member: InitiativeMember | undefined;
  selected: boolean;
  onSelect: (taskId: string) => void;
};
type FrameNodeData = { label: string; kind: "group" | "lane" | "milestones" };
type RouteEdgeData = {
  points: InitiativeLayoutEdge["points"];
  /** The blocker (the source) is neither done nor archived. */
  open: boolean;
  /** It starts or ends at the selected Task. */
  selected: boolean;
};

type TaskFlowNode = Node<TaskNodeData, "task">;
type FrameFlowNode = Node<FrameNodeData, "frame">;
type RouteFlowEdge = Edge<RouteEdgeData, "route">;

export interface InitiativeMapProps {
  layout: InitiativeLayout;
  /** Members and outside blockers by Task id, with the live overlay applied. */
  members: ReadonlyMap<string, InitiativeMember>;
  /** A Project's display name for a group's label. */
  projectLabel: (projectId: string | undefined) => string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

function nodeName(
  layoutNode: InitiativeLayoutNode,
  member: InitiativeMember | undefined,
): string {
  const title = member?.title ?? `Task-${layoutNode.taskId}`;
  const parts = [`${title}, Task-${layoutNode.taskId}`];
  if (layoutNode.kind === "external") parts.push("outside this Initiative");
  if (layoutNode.milestone) parts.push("milestone");
  if (member) parts.push(memberStateLabel(member));
  if (layoutNode.kind === "collapsed" && layoutNode.progress)
    parts.push(
      `${layoutNode.progress.done} of ${layoutNode.progress.total} done`,
    );
  return parts.join(", ");
}

/**
 * One drawn Task. The colour band on its leading edge is its status, the same
 * three states the Backlog's glyph states; blocked, running, milestone and
 * archived are separate marks, so a started Task that is still blocked shows
 * both.
 */
const TaskNode = memo(function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { layoutNode, member, selected, onSelect } = data;
  const external = layoutNode.kind === "external";
  const status = member?.status ?? "todo";
  const band = memberBandClass(member);
  const store = useStoreApi();
  const { setCenter, getZoom } = useReactFlow();
  // A keyboard user tabbing to a Task off screen is brought to it; a pointer
  // that clicked a visible Task is not moved.
  const reveal = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.matches(":focus-visible")) return;
      const { width, height, transform } = store.getState();
      const [tx, ty, zoom] = transform;
      const left = layoutNode.x * zoom + tx;
      const top = layoutNode.y * zoom + ty;
      const inView =
        left >= 0 &&
        top >= 0 &&
        left + layoutNode.width * zoom <= width &&
        top + layoutNode.height * zoom <= height;
      if (inView) return;
      void setCenter(
        layoutNode.x + layoutNode.width / 2,
        layoutNode.y + layoutNode.height / 2,
        { zoom: getZoom() },
      );
    },
    [getZoom, layoutNode, setCenter, store],
  );
  return (
    <div
      className={`relative h-full w-full rounded-lg bg-card ${
        member?.archived ? "opacity-60" : ""
      } ${selected ? "ring-2 ring-primary" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="opacity-0"
      />
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 rounded-l-lg ${band}`}
      />
      <Item
        variant="outline"
        size="xs"
        className="h-full content-start gap-1 pl-3"
        aria-label={nodeName(layoutNode, member)}
        aria-current={selected ? "true" : undefined}
        title={member?.title}
        onFocus={reveal}
        onClick={() => onSelect(layoutNode.taskId)}
        render={<button type="button" />}
      >
        <span className="flex w-full min-w-0 items-start gap-1.5 text-left">
          <span className="mt-0.5 shrink-0" aria-hidden>
            {layoutNode.milestone ? (
              <Flag size={14} className="text-foreground" />
            ) : (
              <TaskStatusIcon status={status} size={14} />
            )}
          </span>
          <span
            className={`line-clamp-2 min-w-0 flex-1 text-xs font-medium ${
              // Finished work recedes, so open work is what the eye finds.
              status === "done" ? "text-muted-foreground" : ""
            }`}
          >
            {member?.title ?? `Task-${layoutNode.taskId}`}
          </span>
        </span>
        <span
          aria-hidden
          className="flex w-full min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground"
        >
          <TaskIdBadge id={layoutNode.taskId} />
          {layoutNode.kind === "collapsed" && layoutNode.progress ? (
            <span className="tabular-nums">
              {layoutNode.progress.done}/{layoutNode.progress.total} done
            </span>
          ) : null}
          <InitiativeStateMarks member={member} outside={external} />
        </span>
      </Item>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="opacity-0"
      />
    </div>
  );
});

/** Drawing only: a Project group, an epic's lane, or the milestone column. */
const FrameNode = memo(function FrameNode({ data }: NodeProps<FrameFlowNode>) {
  const frame =
    data.kind === "group"
      ? "rounded-xl border border-border"
      : data.kind === "lane"
        ? "rounded-lg bg-muted/20"
        : "rounded-xl border border-border bg-accent/40";
  return (
    <div aria-hidden className={`h-full w-full ${frame}`}>
      <div
        className={`flex items-center gap-1.5 truncate px-3 pt-2 ${
          data.kind === "lane"
            ? "text-xs text-muted-foreground"
            : "text-sm font-medium text-foreground"
        }`}
      >
        {data.kind === "milestones" ? <Flag size={14} /> : null}
        {data.label}
      </div>
    </div>
  );
});

/**
 * One `blocks` arrow along the server's route. A link whose blocker is done is
 * drawn faint: the dependency is met, and what still holds work up should be
 * the thing the eye finds.
 */
const RouteEdge = memo(function RouteEdge({ data }: EdgeProps<RouteFlowEdge>) {
  const points = data?.points ?? [];
  if (points.length < 2) return null;
  const open = data?.open ?? true;
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");
  const end = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const dx = Math.sign(end.x - before.x);
  const dy = Math.sign(end.y - before.y);
  // A filled head, long enough to read the direction at the readable zoom;
  // the released edge keeps a smaller one.
  const size = open ? 11 : 7;
  // Orthogonal routes end on an axis, so the head points along it.
  const head = `M${end.x} ${end.y} L${end.x - dx * size - dy * size * 0.5} ${
    end.y - dy * size - dx * size * 0.5
  } L${end.x - dx * size + dy * size * 0.5} ${
    end.y - dy * size + dx * size * 0.5
  } Z`;
  // An edge whose blocker is still open holds work up: strong and wide. One
  // whose blocker is done is released: thin and faint. A selection makes its
  // own edges louder without merging the two kinds.
  const tone = open
    ? data?.selected
      ? "stroke-primary fill-primary"
      : "stroke-foreground/70 fill-foreground/70"
    : data?.selected
      ? "stroke-primary/50 fill-primary/50"
      : "stroke-muted-foreground/40 fill-muted-foreground/40";
  return (
    <g className={tone} data-edge-state={open ? "open" : "done"}>
      <path
        d={path}
        fill="none"
        strokeWidth={open ? (data?.selected ? 2.5 : 2) : 1}
      />
      <path d={head} strokeWidth={0.5} />
    </g>
  );
});

const NODE_TYPES = { task: TaskNode, frame: FrameNode };

/**
 * The map's arrows, along the server's routes. Whether an arrow holds work up
 * is its SOURCE Task's state (the blocker), live from the members, so a
 * blocker finishing releases its arrows without a read or a layout.
 */
export function routeEdges(
  layout: InitiativeLayout,
  members: ReadonlyMap<string, InitiativeMember>,
  selectedTaskId: string | null,
): RouteFlowEdge[] {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  return layout.edges.map((edge, index): RouteFlowEdge => {
    const from = byId.get(edge.from);
    const blocker = from ? members.get(from.taskId) : undefined;
    return {
      id: `edge:${index}`,
      source: edge.from,
      target: edge.to,
      type: "route",
      data: {
        points: edge.points,
        open: blocker ? blocker.status !== "done" && !blocker.archived : true,
        selected:
          selectedTaskId !== null &&
          (from?.taskId === selectedTaskId ||
            byId.get(edge.to)?.taskId === selectedTaskId),
      },
      selectable: false,
      focusable: false,
      zIndex: 2,
    };
  });
}

/** Below this the node text is no longer readable. */
const READABLE_ZOOM = 0.6;
const VIEW_MARGIN = 16;

/**
 * Where the map opens: the whole map when it fits at a readable size, else its
 * full height (the lanes) at a readable zoom from the left edge, where the
 * work starts. "Fit the map" still shows everything.
 */
export function initialViewport(
  layout: Pick<InitiativeLayout, "width" | "height">,
  pane: { width: number; height: number },
): { x: number; y: number; zoom: number } {
  const room = (size: number) => Math.max(size - 2 * VIEW_MARGIN, 1);
  const fit = Math.min(
    room(pane.width) / layout.width,
    room(pane.height) / layout.height,
    1,
  );
  const zoom =
    fit >= READABLE_ZOOM
      ? fit
      : Math.max(READABLE_ZOOM, Math.min(room(pane.height) / layout.height, 1));
  const x =
    fit >= READABLE_ZOOM ? (pane.width - layout.width * zoom) / 2 : VIEW_MARGIN;
  const y = Math.max((pane.height - layout.height * zoom) / 2, VIEW_MARGIN);
  return { x, y, zoom };
}
const EDGE_TYPES = { route: RouteEdge };

/**
 * A member's colour in the overview, by the states its node shows: the overview
 * then reads as a strip of what is ready, moving, held and finished.
 */
export function overviewColor(member: InitiativeMember | undefined): string {
  if (!member || member.archived) return "var(--border)";
  if (member.status === "done") return "var(--success)";
  if (member.blocked) return "var(--warning)";
  if (member.status === "doing") return "var(--foreground)";
  if (member.startable) return "var(--primary)";
  return "var(--muted-foreground)";
}

/**
 * The overview of the whole map: every Task and the milestone column, the
 * visible part framed, pannable and zoomable, and a click goes there. It is drawing, out of the Tab
 * order, and smaller on a narrow pane, where a phone that chose the Map still
 * needs to find its way.
 */
function MapOverview({
  members,
}: {
  members: ReadonlyMap<string, InitiativeMember>;
}) {
  const narrow = useStore((state) => state.width < 640);
  const { setCenter, getZoom } = useReactFlow();
  // A click goes where it points: a Task's box is centred, anywhere else is
  // brought to the middle, at the zoom the reader chose.
  const goTo = useCallback(
    (x: number, y: number) =>
      void setCenter(x, y, { zoom: getZoom(), duration: 200 }),
    [getZoom, setCenter],
  );
  const nodeColor = useCallback(
    (node: TaskFlowNode | FrameFlowNode) =>
      node.type === "task"
        ? overviewColor(members.get(node.data.layoutNode.taskId))
        : "transparent",
    [members],
  );
  return (
    <MiniMap<TaskFlowNode | FrameFlowNode>
      className="initiative-minimap"
      position="bottom-right"
      pannable
      zoomable
      ariaLabel="Map overview"
      nodeColor={nodeColor}
      nodeStrokeWidth={0}
      nodeBorderRadius={2}
      onClick={(_, position) => goTo(position.x, position.y)}
      onNodeClick={(_, node) =>
        goTo(
          node.position.x + (node.width ?? 0) / 2,
          node.position.y + (node.height ?? 0) / 2,
        )
      }
      style={narrow ? { width: 140, height: 84 } : { width: 200, height: 120 }}
    />
  );
}

function MapControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Panel position="top-right" className="flex gap-1">
      <IconButton
        label="Zoom in"
        variant="outline"
        onClick={() => void zoomIn()}
      >
        <ZoomIn />
      </IconButton>
      <IconButton
        label="Zoom out"
        variant="outline"
        onClick={() => void zoomOut()}
      >
        <ZoomOut />
      </IconButton>
      <IconButton
        label="Fit the map"
        variant="outline"
        onClick={() => void fitView({ padding: 0.04 })}
      >
        <Maximize />
      </IconButton>
    </Panel>
  );
}

function InitiativeMapCanvas({
  layout,
  members,
  projectLabel,
  selectedTaskId,
  onSelectTask,
}: InitiativeMapProps) {
  const nodes = useMemo(() => {
    const frames: FrameFlowNode[] = [
      ...layout.groups.map((group, index): FrameFlowNode => ({
        id: `group:${index}`,
        type: "frame",
        position: { x: group.x, y: group.y },
        width: group.width,
        height: group.height,
        style: { width: group.width, height: group.height },
        data: { kind: "group", label: projectLabel(group.projectId) },
        selectable: false,
        focusable: false,
        draggable: false,
        className: "pointer-events-none",
        zIndex: 0,
      })),
      ...layout.lanes.map((lane): FrameFlowNode => ({
        id: `lane:${lane.id}`,
        type: "frame",
        position: { x: lane.x, y: lane.y },
        width: lane.width,
        height: lane.height,
        style: { width: lane.width, height: lane.height },
        data: {
          kind: "lane",
          label: members.get(lane.id)?.title ?? `Task-${lane.id}`,
        },
        selectable: false,
        focusable: false,
        draggable: false,
        className: "pointer-events-none",
        zIndex: 1,
      })),
      ...(layout.milestoneColumn
        ? [
            {
              id: "milestones",
              type: "frame" as const,
              position: {
                x: layout.milestoneColumn.x,
                y: layout.milestoneColumn.y,
              },
              width: layout.milestoneColumn.width,
              height: layout.milestoneColumn.height,
              style: {
                width: layout.milestoneColumn.width,
                height: layout.milestoneColumn.height,
              },
              data: { kind: "milestones" as const, label: "Milestones" },
              selectable: false,
              focusable: false,
              draggable: false,
              className: "pointer-events-none",
              zIndex: 0,
            },
          ]
        : []),
    ];
    // Reading order for Tab: lane by lane (the milestone column last), left to
    // right, then top to bottom.
    const laneOrder = new Map(
      layout.lanes.map((lane, index) => [lane.id, index]),
    );
    const ordered = [...layout.nodes].sort(
      (a, b) =>
        (laneOrder.get(a.laneId ?? "") ?? laneOrder.size) -
          (laneOrder.get(b.laneId ?? "") ?? laneOrder.size) ||
        a.x - b.x ||
        a.y - b.y,
    );
    const tasks = ordered.map((layoutNode): TaskFlowNode => ({
      id: layoutNode.id,
      type: "task",
      position: { x: layoutNode.x, y: layoutNode.y },
      width: layoutNode.width,
      height: layoutNode.height,
      // React Flow gives a node that is neither selectable nor draggable
      // `pointer-events: none`, which would leave the button inside it
      // unclickable by mouse; frames keep that, so they never take input.
      style: {
        width: layoutNode.width,
        height: layoutNode.height,
        pointerEvents: "all",
      },
      data: {
        layoutNode,
        member: members.get(layoutNode.taskId),
        selected: layoutNode.taskId === selectedTaskId,
        onSelect: onSelectTask,
      },
      selectable: false,
      focusable: false,
      draggable: false,
      zIndex: 3,
    }));
    return [...frames, ...tasks];
  }, [layout, members, projectLabel, selectedTaskId, onSelectTask]);

  const edges = useMemo(
    () => routeEdges(layout, members, selectedTaskId),
    [layout, members, selectedTaskId],
  );

  const paneRef = useRef<HTMLDivElement>(null);
  const openAtReadableZoom = useCallback(
    (
      instance: ReactFlowInstance<TaskFlowNode | FrameFlowNode, RouteFlowEdge>,
    ) => {
      const pane = paneRef.current;
      if (!pane) return;
      void instance.setViewport(
        initialViewport(layout, {
          width: pane.clientWidth,
          height: pane.clientHeight,
        }),
      );
    },
    [layout],
  );

  return (
    <ReactFlow<TaskFlowNode | FrameFlowNode, RouteFlowEdge>
      ref={paneRef}
      onInit={openAtReadableZoom}
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      zoomOnDoubleClick={false}
      minZoom={0.15}
      maxZoom={1.5}
      fitViewOptions={{ padding: 0.04 }}
      proOptions={{ hideAttribution: false }}
      attributionPosition="bottom-left"
    >
      <MapControls />
      <MapOverview members={members} />
    </ReactFlow>
  );
}

export default function InitiativeMap(props: InitiativeMapProps) {
  return (
    <section
      aria-label="Initiative map"
      aria-describedby="initiative-map-help"
      className="relative h-full w-full"
    >
      <p id="initiative-map-help" className="sr-only">
        Each Task is a button, in lane order. Press Enter to open it in the
        object panel. Drag the background or scroll to move around the map.
      </p>
      <ReactFlowProvider>
        <InitiativeMapCanvas {...props} />
      </ReactFlowProvider>
    </section>
  );
}
