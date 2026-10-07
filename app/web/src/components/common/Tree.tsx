import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  KeyboardCode,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight } from "lucide-react";

import {
  applyGroupMove,
  buildTree,
  flattenTree,
  getProjection,
  removeChildrenOf,
  selectionRoots,
  visibleNodes,
  type FlattenedNode,
  type TreeNode,
  type TreeProjection,
} from "./tree-model.ts";
import {
  matchesCombo,
  useShortcuts,
  type ShortcutDef,
  type ShortcutGroup,
} from "./shortcuts.tsx";
import { SwipeRow, type SwipeAction } from "./SwipeRow.tsx";

export type { TreeNode } from "./tree-model.ts";

/**
 * A keyboard action bound to the focused row (Gmail-style). Fires when the row
 * has focus and one of `keys` is pressed; `run` receives the effective target
 * ids — the whole multi-selection when the focused row is part of a selection of
 * more than one, otherwise just the focused row. Listed in the shortcuts help
 * overlay when the tree is given a `shortcutsTitle`.
 */
export interface TreeRowAction {
  keys: string[];
  label: string;
  run: (targetIds: string[]) => void;
  /** Whether the action applies to the focused node. Defaults to always. */
  enabled?: (node: TreeNode<unknown>) => boolean;
}

/**
 * The touch equivalent of a `TreeRowAction`: an action revealed by swiping the
 * row, one per side, committed on release (`components/common/SwipeRow`). Returned
 * per node, so a tree offers each only on the rows where it applies — an
 * offered swipe that refuses on release is worse than no swipe at all, and a
 * row may well offer one side and not the other.
 *
 * Either side may be absent; a node with neither has no swipe at all and must
 * return `null`, so that a row which reveals nothing does not take touches away
 * from the list's scrolling.
 *
 * It acts on the row it is performed on, never on the multi-selection: a finger
 * has not selected anything.
 */
export interface TreeRowSwipe {
  /** Revealed by a LEFTWARD pull, on the row's right-hand edge. */
  left?: SwipeAction;
  /** Revealed by a RIGHTWARD pull, on the row's left-hand edge. */
  right?: SwipeAction;
  /** The row has finished leaving; drop it from `items` for real. */
  onExited?: () => void;
}

/** Result of a drag: the (anchor) moved node, its new parent + sibling index,
 * every moved root (`ids`, for multi-select group drags), and the whole new
 * nested tree (apply optimistically, or emit an event from it). */
interface TreeMoveResult<T> {
  id: string;
  ids: string[];
  parentId: string | null;
  index: number;
  /** The node id the pointer was over at drop, before projection. Useful when a
   * caller wants the literal drop target rather than the reparenting projection
   * (e.g. resolving which project group a row was dropped onto). */
  overId: string | null;
  items: TreeNode<T>[];
}

/** Per-node state passed to `renderNode`. */
export interface TreeNodeState {
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  selected: boolean;
}

export interface TreeProps<T> {
  /** The hierarchy to display. */
  items: TreeNode<T>[];
  /** Render a node's content. Return one line for a simple tree, or a multi-row
   * block for a richer one. */
  renderNode: (node: TreeNode<T>, state: TreeNodeState) => ReactNode;

  /** Controlled set of expanded node ids. */
  expandedIds?: string[];
  /** Initial expanded ids when uncontrolled. */
  defaultExpandedIds?: string[];
  /** Called when the expanded set should change. */
  onExpandedChange?: (ids: string[]) => void;

  /** Controlled set of selected node ids (multi-select). */
  selectedIds?: string[];
  /** Initial selection when uncontrolled. */
  defaultSelectedIds?: string[];
  /** Called when the selection should change. Plain click replaces; shift /
   * ⌘ / ctrl-click toggles a node in or out of the selection. */
  onSelectionChange?: (ids: string[]) => void;

  /** Keyboard actions bound to the focused row (e.g. archive/delete). */
  rowActions?: TreeRowAction[] | undefined;
  /**
   * Touch swipe action for a row, or `null` where the row has none. Ignored for
   * mouse and keyboard, which have the row actions and the row's own controls.
   */
  rowSwipe?: ((node: TreeNode<T>) => TreeRowSwipe | null) | undefined;
  /** When set (with `rowActions` and/or navigation), the tree registers a
   * shortcuts help group under this title so `?` documents its keys. */
  shortcutsTitle?: string;

  /**
   * Enable drag-and-drop reorder + reparent. When provided, a row can be
   * dragged (touch long-press / mouse / keyboard); dropping fires this. If the
   * dragged node is part of a multi-selection, the whole selection moves.
   */
  onMove?: (result: TreeMoveResult<T>) => void;
  /** Whether a node may be dragged. Defaults to all. */
  canDrag?: (node: TreeNode<T>) => boolean;
  /** Whether a drop is allowed (e.g. a file can't become a parent). */
  canDrop?: (args: {
    id: string;
    parentId: string | null;
    index: number;
  }) => boolean;

  /** Indentation per depth level, in px. Defaults to `24`. */
  indentWidth?: number;
  /** Draw vertical indent guides. Defaults to `true`. */
  showGuides?: boolean;
  /** Tight single-line density for sidebar browsers: 28px rows and a smaller
   * chevron, matching the sidebar session rows. Defaults to `false`. */
  compact?: boolean;
  /**
   * How a row's chrome sits against a `renderNode` body of more than one line.
   * `center` (the default) centres the chevron on a single-line row; `stretch`
   * turns it into a full-height gutter beside the whole block, with the GLYPH on
   * the body's first line — so it reads against the title it folds away rather
   * than floating between the lines, and does not share a spot with whatever
   * control the body puts at its own left edge. The row's HEIGHT stays the
   * body's business.
   */
  rowAlign?: "center" | "stretch";
  /** Extra classes on a row, by node + state. */
  getRowClassName?: (node: TreeNode<T>, state: TreeNodeState) => string;
  /** Extra classes on the tree container. */
  className?: string | undefined;
  /** Accessible label for the tree. */
  "aria-label"?: string;
}

const measuring = { droppable: { strategy: MeasuringStrategy.Always } };
const MOUSE_DRAG_DISTANCE_PX = 4;
const TOUCH_LONG_PRESS_DELAY_MS = 500;
const TOUCH_LONG_PRESS_TOLERANCE_PX = 8;
// Keyboard drag uses Space only, leaving Enter free to select a row.
const keyboardCodes = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space],
};

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Controlled value with an uncontrolled fallback (Radix-style). */
function useControllable<V>(
  controlled: V | undefined,
  defaultValue: V,
  onChange?: (value: V) => void,
): [V, (value: V) => void] {
  const [internal, setInternal] = useState(defaultValue);
  const isControlled = controlled !== undefined;
  const value = isControlled ? (controlled as V) : internal;
  const setValue = useCallback(
    (next: V) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );
  return [value, setValue];
}

/**
 * @component Tree
 * @purpose A reusable hierarchy view (ported from v2 `packages/ui`): consistent
 * chrome (indentation, indent guides, expand/collapse, subtle selection,
 * keyboard navigation) with caller-rendered row content, so the same component
 * serves a simple list and a richer multi-row task tree. Supports multi-select
 * (shift / ⌘-click) and @dnd-kit drag (whole row, long-press on touch) for
 * reorder + reparent — a multi-selection drags as a group.
 * @useWhen A surface needs a generic, domain-free hierarchy with multi-select
 * and/or drag-to-reparent (e.g. the Backlog task tree and project-layer view).
 * @avoidWhen A flat, non-draggable list suffices — render plain rows instead.
 * @intent Stays domain-free: it speaks `TreeNode<T>` and calls `renderNode`,
 * never reading into `data`. Pass `onMove` to enable drag; callers translate the
 * `TreeMoveResult` into their own persistence (e.g. placements/reorderTasks).
 * @related components/common/tree-model.ts, BacklogTreePane.tsx
 */
export function Tree<T>({
  items,
  renderNode,
  expandedIds,
  defaultExpandedIds = [],
  onExpandedChange,
  selectedIds,
  defaultSelectedIds = [],
  onSelectionChange,
  rowActions,
  rowSwipe,
  shortcutsTitle,
  onMove,
  canDrag,
  canDrop,
  indentWidth = 24,
  showGuides = true,
  compact = false,
  rowAlign = "center",
  getRowClassName,
  className,
  "aria-label": ariaLabel,
}: TreeProps<T>) {
  const draggable = Boolean(onMove);

  // Document this tree's keys in the `?` help overlay while it is mounted. The
  // row actions are listed display-only; they are dispatched from the focused
  // row's key handler, not the global registry.
  const shortcutsGroup = useMemo<ShortcutGroup | null>(() => {
    if (!shortcutsTitle) return null;
    const nav: ShortcutDef[] = [
      {
        keys: ["arrowup", "arrowdown"],
        label: "Move between rows",
        keyHint: "↑ ↓",
      },
      {
        keys: ["arrowright", "arrowleft"],
        label: "Expand / collapse",
        keyHint: "→ ←",
      },
      { keys: ["enter"], label: "Open / select row" },
    ];
    const actions: ShortcutDef[] = (rowActions ?? []).map((a) => ({
      keys: a.keys,
      label: a.label,
    }));
    return { title: shortcutsTitle, shortcuts: [...nav, ...actions] };
  }, [shortcutsTitle, rowActions]);
  useShortcuts(shortcutsGroup);

  const [expanded, setExpanded] = useControllable(
    expandedIds,
    defaultExpandedIds,
    onExpandedChange,
  );
  const [selected, setSelected] = useControllable(
    selectedIds,
    defaultSelectedIds,
    onSelectionChange,
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);

  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const baseVisible = useMemo(
    () => visibleNodes(items, expandedSet),
    [items, expandedSet],
  );

  // The roots that move when the active node is dragged: the whole selection if
  // the active node is part of it, otherwise just the active node.
  const movingRootIds = useMemo(() => {
    if (activeId == null) return [];
    const roots = selectionRoots(items, selected);
    return selectedSet.has(activeId) && roots.length > 1 ? roots : [activeId];
  }, [activeId, items, selected, selectedSet]);

  // While dragging, hide the moving subtrees (so a group can't be dropped
  // inside itself) and collapse the *other* selected members out of the tree —
  // they ride along in the dragged stack, so they shouldn't stay in place.
  const flattened = useMemo(() => {
    if (activeId == null) return baseVisible;
    const withoutSubtrees = removeChildrenOf(baseVisible, movingRootIds);
    if (movingRootIds.length <= 1) return withoutSubtrees;
    const others = new Set(movingRootIds.filter((id) => id !== activeId));
    return withoutSubtrees.filter((n) => !others.has(n.id));
  }, [baseVisible, activeId, movingRootIds]);
  const ids = useMemo(() => flattened.map((n) => n.id), [flattened]);

  const projected =
    draggable && activeId && overId
      ? getProjection(flattened, activeId, overId, offsetLeft, indentWidth)
      : null;

  // Mouse can still start after an intentional small movement, but touch must
  // hold long enough to distinguish reordering from normal mobile scrolling and
  // tapping. The tolerance cancels activation if the finger drifts before the
  // long-press delay elapses.
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: MOUSE_DRAG_DISTANCE_PX },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: TOUCH_LONG_PRESS_DELAY_MS,
        tolerance: TOUCH_LONG_PRESS_TOLERANCE_PX,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes,
    }),
  );

  const setExpandedFor = useCallback(
    (id: string, next: boolean) => {
      const set = new Set(expandedSet);
      if (next) set.add(id);
      else set.delete(id);
      setExpanded([...set]);
    },
    [expandedSet, setExpanded],
  );

  const focusRow = useCallback((id: string | null) => {
    if (!id) return;
    setFocusedId(id);
    const el = rowRefs.current.get(id);
    // Focus, then scroll into view with `block: "nearest"`. The rows carry a
    // small `scroll-my` margin so the focus ring (a 2px box-shadow drawn
    // outside the row box) isn't clipped by the scroll container's overflow
    // when the focused row sits flush against the top or bottom edge.
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  const selectNode = useCallback(
    (node: FlattenedNode<T>, multi: boolean) => {
      setFocusedId(node.id);
      if (!multi) {
        setSelected([node.id]);
        return;
      }
      const set = new Set(selected);
      if (set.has(node.id)) set.delete(node.id);
      else set.add(node.id);
      setSelected([...set]);
    },
    [selected, setSelected],
  );

  const handleRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLLIElement>, node: FlattenedNode<T>) => {
      const idx = flattened.findIndex((n) => n.id === node.id);
      const at = (i: number) => flattened[i]?.id ?? null;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusRow(at(Math.min(idx + 1, flattened.length - 1)));
          break;
        case "ArrowUp":
          event.preventDefault();
          focusRow(at(Math.max(idx - 1, 0)));
          break;
        case "ArrowRight":
          event.preventDefault();
          if (node.children.length) {
            if (!expandedSet.has(node.id)) setExpandedFor(node.id, true);
            else focusRow(at(idx + 1));
          }
          break;
        case "ArrowLeft":
          event.preventDefault();
          if (node.children.length && expandedSet.has(node.id))
            setExpandedFor(node.id, false);
          else if (node.parentId) focusRow(node.parentId);
          break;
        case "Home":
          event.preventDefault();
          focusRow(at(0));
          break;
        case "End":
          event.preventDefault();
          focusRow(at(flattened.length - 1));
          break;
        case "Enter":
          // Enter belongs to whatever is FOCUSED. A control inside the row (a
          // status glyph, Archive, a gutter action) is activated by the browser
          // dispatching a click as the DEFAULT action of this very keydown, so
          // preventing it here would swallow the row's own primary action and
          // select the row instead. Space needs no guard: `useSortable`'s
          // activator node is this row, and @dnd-kit's KeyboardSensor refuses to
          // start a drag from any other target.
          if (event.target !== event.currentTarget) break;
          event.preventDefault();
          selectNode(node, event.shiftKey || event.metaKey || event.ctrlKey);
          break;
        default: {
          if (!rowActions?.length) break;
          const action = rowActions.find((a) =>
            a.keys.some((combo) => matchesCombo(event.nativeEvent, combo)),
          );
          if (!action) break;
          if (action.enabled && !action.enabled(toNode(node))) break;
          event.preventDefault();
          // Act on the whole selection when the focused row is part of a
          // multi-selection; otherwise just the focused row.
          const roots = selectionRoots(items, selected);
          const targetIds =
            selectedSet.has(node.id) && roots.length > 1 ? roots : [node.id];
          action.run(targetIds);
          break;
        }
      }
    },
    [
      flattened,
      expandedSet,
      focusRow,
      setExpandedFor,
      selectNode,
      rowActions,
      items,
      selected,
      selectedSet,
    ],
  );

  const resetDrag = useCallback(() => {
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
  }, []);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      const proj: TreeProjection | null = projected;
      resetDrag();
      if (!proj || !over) return;
      const activeIdStr = String(active.id);
      const overIdStr = String(over.id);

      const clone = flattenTree(items);
      const overIndex = clone.findIndex((n) => n.id === overIdStr);
      const activeIndex = clone.findIndex((n) => n.id === activeIdStr);
      const activeFlat = clone[activeIndex];
      if (!activeFlat || overIndex < 0) return;

      // Commit the active node first to learn its target sibling index.
      const reassigned = clone.slice();
      reassigned[activeIndex] = {
        ...activeFlat,
        depth: proj.depth,
        parentId: proj.parentId,
      };
      const singleItems = buildTree(
        arrayMove(reassigned, activeIndex, overIndex),
      );
      const index =
        flattenTree(singleItems).find((n) => n.id === activeIdStr)?.index ?? 0;

      if (
        canDrop &&
        !canDrop({ id: activeIdStr, parentId: proj.parentId, index })
      )
        return;

      const roots = selectionRoots(items, selected);
      const isGroup = selectedSet.has(activeIdStr) && roots.length > 1;
      const nextItems = isGroup
        ? applyGroupMove(items, selected, proj.parentId, index)
        : singleItems;
      onMove?.({
        id: activeIdStr,
        ids: isGroup ? roots : [activeIdStr],
        parentId: proj.parentId,
        index,
        overId: overIdStr,
        items: nextItems,
      });
    },
    [projected, resetDrag, items, canDrop, selected, selectedSet, onMove],
  );

  const renderRow = (node: FlattenedNode<T>) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedSet.has(node.id);
    const state: TreeNodeState = {
      depth: node.depth,
      expanded: isExpanded,
      hasChildren,
      selected: selectedSet.has(node.id),
    };
    const depth =
      node.id === activeId && projected ? projected.depth : node.depth;

    const common = {
      node,
      depth,
      indentWidth,
      showGuides,
      compact,
      rowAlign,
      hasChildren,
      isExpanded,
      isFocused: (focusedId ?? flattened[0]?.id) === node.id,
      selected: state.selected,
      content: renderNode(node, state),
      swipe: rowSwipe?.(toNode(node)) ?? null,
      rowClassName: getRowClassName?.(node, state),
      onToggle: () => setExpandedFor(node.id, !isExpanded),
      onSelect: (e: ReactMouseEvent<HTMLLIElement>) =>
        selectNode(node, e.shiftKey || e.metaKey || e.ctrlKey),
      onKeyDown: (e: ReactKeyboardEvent<HTMLLIElement>) =>
        handleRowKeyDown(e, node),
      registerRef: (el: HTMLLIElement | null) => {
        if (el) rowRefs.current.set(node.id, el);
        else rowRefs.current.delete(node.id);
      },
    };

    // Group-drag affordance: the dragged row becomes a stack (offset cards
    // behind) and shows how many items move; the others have collapsed out.
    const isActive = node.id === activeId;
    const dragBadge =
      isActive && movingRootIds.length > 1 ? movingRootIds.length : undefined;

    return draggable ? (
      <SortableRow
        key={node.id}
        {...common}
        dragEnabled={canDrag ? canDrag(toNode(node)) : true}
        stacked={dragBadge != null}
        dragBadge={dragBadge}
      />
    ) : (
      <StaticRow key={node.id} {...common} />
    );
  };

  const tree = (
    <ul
      role="tree"
      aria-label={ariaLabel}
      className={cx("select-none", className)}
    >
      {flattened.map(renderRow)}
    </ul>
  );

  if (!draggable) return tree;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={measuring}
      onDragStart={({ active }: DragStartEvent) => {
        setActiveId(String(active.id));
        setOverId(String(active.id));
      }}
      onDragMove={({ delta }: DragMoveEvent) => setOffsetLeft(delta.x)}
      onDragOver={({ over }: DragOverEvent) =>
        setOverId(over ? String(over.id) : null)
      }
      onDragEnd={handleDragEnd}
      onDragCancel={resetDrag}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {tree}
      </SortableContext>
    </DndContext>
  );
}

/** Lift a flattened node back to a minimal `TreeNode` for the `canDrag` callback. */
function toNode<T>(node: FlattenedNode<T>): TreeNode<T> {
  return node.children.length
    ? { id: node.id, data: node.data, children: node.children }
    : { id: node.id, data: node.data };
}

interface RowProps<T> {
  node: FlattenedNode<T>;
  depth: number;
  indentWidth: number;
  showGuides: boolean;
  compact: boolean;
  rowAlign: "center" | "stretch";
  hasChildren: boolean;
  isExpanded: boolean;
  isFocused: boolean;
  selected: boolean;
  content: ReactNode;
  swipe?: TreeRowSwipe | null;
  rowClassName?: string | undefined;
  onToggle: () => void;
  onSelect: (e: ReactMouseEvent<HTMLLIElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLLIElement>) => void;
  registerRef: (el: HTMLLIElement | null) => void;
}

/** The chrome inside a row: indent guides, chevron, content, and (while
 * group-dragging) a count badge. */
function RowBody<T>({
  depth,
  indentWidth,
  showGuides,
  compact,
  rowAlign,
  hasChildren,
  isExpanded,
  selected,
  content,
  onToggle,
  badge,
  elevated,
}: Pick<
  RowProps<T>,
  | "depth"
  | "indentWidth"
  | "showGuides"
  | "compact"
  | "rowAlign"
  | "hasChildren"
  | "isExpanded"
  | "selected"
  | "content"
  | "onToggle"
> & { badge?: number | undefined; elevated?: boolean }) {
  const stretch = rowAlign === "stretch";
  return (
    <div
      className={cx(
        "relative z-10 flex gap-1 rounded-md text-fg transition-colors",
        stretch ? "items-stretch" : "items-center",
        // The indent animates (`index.css`) so a row promoted out of a vanished
        // parent moves to its new depth rather than appearing at it.
        !elevated && "tree-row-indent",
        compact ? "min-h-7 pl-0.5 pr-1" : "min-h-9 pl-1 pr-2",
        // While dragging, the row reads as a lifted card; otherwise a subtle
        // selection tint (no text recolor, so the hierarchy stays legible).
        elevated
          ? "border border-line bg-panel shadow-lg"
          : selected
            ? "bg-accent/60"
            : "hover:bg-raised",
      )}
      style={{ paddingLeft: depth * indentWidth }}
    >
      {showGuides &&
        Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="absolute inset-y-0 w-px bg-line"
            style={{ left: i * indentWidth + indentWidth / 2 }}
          />
        ))}
      {hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={cx(
            "flex shrink-0 justify-center rounded text-muted-foreground hover:bg-raised",
            // Narrow and TALL when stretched: a wide chevron would carve swipe-
            // dead area out of the row (it stops `pointerdown`), and at depth ≥ 1
            // that strip is live area `SWIPE_EDGE_GUARD_PX` does not already take.
            // The TARGET is the full height; the glyph is pinned to the first
            // line. `pt-2` is the sum of the two paddings above the body's own
            // first line — this row's content wrapper (`py-1`, below) and the
            // control the body starts with (`BacklogTreePane`'s status button
            // adds `pt-1`) — so a change to either leaves the chevron a few
            // pixels off rather than breaking anything. Eyeball it against the
            // status glyph.
            stretch
              ? "w-7 items-start pt-2 text-faint hover:text-fg"
              : compact
                ? "size-4 items-center text-faint hover:text-fg"
                : "size-5 items-center",
          )}
        >
          <ChevronRight
            size={compact ? 12 : 14}
            className={cx("transition-transform", isExpanded && "rotate-90")}
          />
        </button>
      ) : (
        <span
          className={cx(
            "shrink-0",
            stretch ? "w-7" : compact ? "w-4" : "size-5",
          )}
        />
      )}
      <div className={cx("min-w-0 flex-1", compact ? "py-0.5" : "py-1")}>
        {content}
      </div>
      {badge != null && (
        <span className="ml-1 shrink-0 self-center rounded-full bg-primary px-1.5 text-sm font-semibold text-primary-foreground">
          {badge}
        </span>
      )}
    </div>
  );
}

/**
 * The row body, wrapped in its swipe surface when the row has one. The wrapper
 * is inside the `li`, so the row keeps its focus ring, its selection click and
 * its drag listeners while only the drawn body travels under the finger.
 *
 * `dragging` is the seam where the two touch gestures meet, and it is the only
 * place that knows both. A fast swipe cancels the drag sensor by itself (8px of
 * drift inside its 500ms long press), but a finger that RESTS and then pulls
 * left activates the drag first and would otherwise also engage the swipe —
 * reordering the row and archiving it from one gesture. The drag wins, because
 * it is the one that already started.
 */
function SwipeableRowBody<T>(
  props: RowProps<T> & {
    badge?: number | undefined;
    elevated?: boolean;
    dragging?: boolean;
  },
) {
  const body = <RowBody {...props} />;
  if (!props.swipe) return body;
  return (
    <SwipeRow
      left={props.swipe.left}
      right={props.swipe.right}
      onExited={props.swipe.onExited}
      disabled={props.dragging}
    >
      {body}
    </SwipeRow>
  );
}

function StaticRow<T>(props: RowProps<T>) {
  return (
    <li
      ref={props.registerRef}
      // The row's anchor for scroll restoration (`hooks/useListScroll.ts`).
      data-list-row-id={props.node.id}
      role="treeitem"
      aria-level={props.node.depth + 1}
      aria-selected={props.selected}
      aria-expanded={props.hasChildren ? props.isExpanded : undefined}
      tabIndex={props.isFocused ? 0 : -1}
      onClick={props.onSelect}
      onKeyDown={props.onKeyDown}
      className={cx(
        "list-none scroll-my-1 outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        props.rowClassName,
      )}
    >
      <SwipeableRowBody {...props} />
    </li>
  );
}

function SortableRow<T>(
  props: RowProps<T> & {
    dragEnabled: boolean;
    stacked?: boolean;
    dragBadge?: number | undefined;
  },
) {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.node.id,
    disabled: !props.dragEnabled,
  });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition ?? undefined,
  };

  // The whole row is the drag activator: touch requires a proper long press,
  // while mouse requires a small intentional movement. A normal tap/click still
  // selects the row.
  const dragListeners = props.dragEnabled ? listeners : undefined;

  return (
    <li
      ref={(el) => {
        setNodeRef(el);
        // The ROW is the drag activator, and saying so is what stops a keyboard
        // drag starting from a control inside it: @dnd-kit's KeyboardSensor
        // ignores a Space whose target is not the activator node, but only once
        // an activator node exists — with none it accepts any target, so
        // pressing a row's own button both activated it and picked the row up.
        setActivatorNodeRef(el);
        props.registerRef(el);
      }}
      // The row's anchor for scroll restoration (`hooks/useListScroll.ts`).
      data-list-row-id={props.node.id}
      role="treeitem"
      aria-level={props.node.depth + 1}
      aria-selected={props.selected}
      aria-expanded={props.hasChildren ? props.isExpanded : undefined}
      aria-roledescription={props.dragEnabled ? "Draggable item" : undefined}
      tabIndex={props.isFocused ? 0 : -1}
      {...dragListeners}
      onClick={props.onSelect}
      onKeyDown={(e) => {
        dragListeners?.onKeyDown?.(e);
        if (!isDragging) props.onKeyDown(e);
      }}
      style={style}
      className={cx(
        "relative list-none scroll-my-1 touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        props.rowClassName,
      )}
    >
      {/* Stack effect for a group drag: offset cards peeking behind the row. */}
      {isDragging && props.stacked && (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 translate-x-[6px] translate-y-[6px] rounded-md border border-line bg-panel shadow"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-md border border-line bg-panel shadow"
          />
        </>
      )}
      <SwipeableRowBody
        {...props}
        badge={props.dragBadge}
        elevated={isDragging}
        dragging={isDragging}
      />
    </li>
  );
}
