/**
 * Pure, framework-free tree helpers shared by the `Tree` component (ported from
 * the v2 `packages/ui/src/tree`). These are the load-bearing pieces for hierarchy
 * display and — critically — for correct **reparenting**: `getProjection` derives
 * a node's new depth + parent from a drop position and horizontal drag offset, the
 * logic that is easy to get wrong by hand. Everything here is deterministic.
 */

/** A node in a hierarchy. `data` carries the caller's domain object; the Tree
 * never reads into it. */
export interface TreeNode<T> {
  /** Stable, unique identifier. */
  id: string;
  /** Caller's domain payload (rendered via the Tree's `renderNode`). */
  data: T;
  /** Child nodes; absent or empty means a leaf. */
  children?: TreeNode<T>[];
}

/** A node lifted out of the hierarchy into a flat, render-order list. */
export interface FlattenedNode<T> {
  id: string;
  data: T;
  /** The node's own children (kept so the flat list can be rebuilt). */
  children: TreeNode<T>[];
  /** Parent id, or `null` at the root. */
  parentId: string | null;
  /** Nesting depth (root = 0). */
  depth: number;
  /** Position among its siblings. */
  index: number;
}

/** Where a dragged node would land: its new depth and parent. */
export interface TreeProjection {
  depth: number;
  parentId: string | null;
}

/** A move to apply: place `id` under `parentId` at sibling `index`. */
export interface TreeMove {
  id: string;
  parentId: string | null;
  index: number;
}

function arrayMove<U>(items: U[], from: number, to: number): U[] {
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function flattenInner<T>(
  nodes: TreeNode<T>[],
  parentId: string | null,
  depth: number,
): FlattenedNode<T>[] {
  return nodes.reduce<FlattenedNode<T>[]>((acc, node, index) => {
    const children = node.children ?? [];
    acc.push({
      id: node.id,
      data: node.data,
      children,
      parentId,
      depth,
      index,
    });
    if (children.length)
      acc.push(...flattenInner(children, node.id, depth + 1));
    return acc;
  }, []);
}

/** Depth-first pre-order flatten of a nested tree into a render-order list. */
export function flattenTree<T>(items: TreeNode<T>[]): FlattenedNode<T>[] {
  return flattenInner(items, null, 0);
}

/** Rebuild a nested tree from a flat list (inverse of `flattenTree`). */
export function buildTree<T>(flattened: FlattenedNode<T>[]): TreeNode<T>[] {
  const rootId = "__root__";
  const root: TreeNode<T> = {
    id: rootId,
    data: undefined as unknown as T,
    children: [],
  };
  const nodes = new Map<string, TreeNode<T>>([[rootId, root]]);
  for (const item of flattened) {
    nodes.set(item.id, { id: item.id, data: item.data, children: [] });
  }
  for (const item of flattened) {
    const node = nodes.get(item.id);
    const parent = nodes.get(item.parentId ?? rootId) ?? root;
    if (node) parent.children?.push(node);
  }
  // Normalize: leaves carry no `children` key, so the result is a clean inverse
  // of `flattenTree` (and a tidy payload for `onMove`).
  const normalize = (siblings: TreeNode<T>[]): TreeNode<T>[] =>
    siblings.map((node) =>
      node.children && node.children.length
        ? { ...node, children: normalize(node.children) }
        : { id: node.id, data: node.data },
    );
  return normalize(root.children ?? []);
}

/** Drop the descendants of any node whose id is in `ids` (collapsed nodes, or
 * the actively-dragged node so it can't be dropped into itself). */
export function removeChildrenOf<T>(
  items: FlattenedNode<T>[],
  ids: string[],
): FlattenedNode<T>[] {
  const exclude = new Set(ids);
  return items.filter((item) => {
    if (item.parentId && exclude.has(item.parentId)) {
      if (item.children.length) exclude.add(item.id);
      return false;
    }
    return true;
  });
}

/** The visible flat list given the set of expanded node ids: descendants of a
 * collapsed parent are hidden. */
export function visibleNodes<T>(
  items: TreeNode<T>[],
  expandedIds: Iterable<string>,
): FlattenedNode<T>[] {
  const expanded = new Set(expandedIds);
  const flat = flattenTree(items);
  const collapsed = flat
    .filter((node) => node.children.length && !expanded.has(node.id))
    .map((node) => node.id);
  return removeChildrenOf(flat, collapsed);
}

/**
 * Given a flat list and a drag (active over a target with a horizontal offset),
 * compute where the active node would land. Ported from the dnd-kit sortable
 * tree example: depth comes from the horizontal offset, clamped to what the
 * neighbouring rows allow, and the parent is derived from the row above.
 */
export function getProjection<T>(
  items: FlattenedNode<T>[],
  activeId: string,
  overId: string,
  dragOffset: number,
  indentationWidth: number,
): TreeProjection | null {
  const overItemIndex = items.findIndex((item) => item.id === overId);
  const activeItemIndex = items.findIndex((item) => item.id === activeId);
  const activeItem = items[activeItemIndex];
  if (!activeItem || overItemIndex < 0) return null;

  const newItems = arrayMove(items, activeItemIndex, overItemIndex);
  const previousItem = newItems[overItemIndex - 1];
  const nextItem = newItems[overItemIndex + 1];
  const dragDepth = Math.round(dragOffset / indentationWidth);
  const projectedDepth = activeItem.depth + dragDepth;
  const maxDepth = previousItem ? previousItem.depth + 1 : 0;
  const minDepth = nextItem ? nextItem.depth : 0;
  const depth =
    projectedDepth >= maxDepth
      ? maxDepth
      : projectedDepth < minDepth
        ? minDepth
        : projectedDepth;

  function getParentId(): string | null {
    if (depth === 0 || !previousItem) return null;
    if (depth === previousItem.depth) return previousItem.parentId;
    if (depth > previousItem.depth) return previousItem.id;
    const newParent = newItems
      .slice(0, overItemIndex)
      .reverse()
      .find((item) => item.depth === depth)?.parentId;
    return newParent ?? null;
  }

  return { depth, parentId: getParentId() };
}

function extractNode<T>(
  items: TreeNode<T>[],
  id: string,
): { tree: TreeNode<T>[]; node: TreeNode<T> } | null {
  const holder: { node: TreeNode<T> | null } = { node: null };
  function walk(nodes: TreeNode<T>[]): TreeNode<T>[] {
    const out: TreeNode<T>[] = [];
    for (const node of nodes) {
      if (node.id === id) {
        holder.node = node;
        continue;
      }
      if (node.children) out.push({ ...node, children: walk(node.children) });
      else out.push(node);
    }
    return out;
  }
  const tree = walk(items);
  return holder.node ? { tree, node: holder.node } : null;
}

function insertNode<T>(
  items: TreeNode<T>[],
  parentId: string | null,
  index: number,
  node: TreeNode<T>,
): TreeNode<T>[] {
  if (parentId == null) {
    const out = items.slice();
    out.splice(clamp(index, 0, out.length), 0, node);
    return out;
  }
  return items.map((current) => {
    if (current.id === parentId) {
      const children = (current.children ?? []).slice();
      children.splice(clamp(index, 0, children.length), 0, node);
      return { ...current, children };
    }
    if (current.children)
      return {
        ...current,
        children: insertNode(current.children, parentId, index, node),
      };
    return current;
  });
}

/** Apply a move immutably: detach `move.id` (with its subtree) and re-insert it
 * under `move.parentId` at `move.index`. Returns the original items if not found. */
export function applyMove<T>(
  items: TreeNode<T>[],
  move: TreeMove,
): TreeNode<T>[] {
  const extracted = extractNode(items, move.id);
  if (!extracted) return items;
  return insertNode(extracted.tree, move.parentId, move.index, extracted.node);
}

function findNode<T>(items: TreeNode<T>[], id: string): TreeNode<T> | null {
  for (const node of items) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

function childIndexOf<T>(
  items: TreeNode<T>[],
  parentId: string | null,
  id: string,
): number {
  const siblings =
    parentId == null ? items : (findNode(items, parentId)?.children ?? []);
  return siblings.findIndex((child) => child.id === id);
}

/**
 * Reduce a selection to its "roots": ids whose ancestor is **not** also
 * selected. Moving a node already moves its whole subtree, so a selected child
 * of a selected parent must not be moved twice. Returned in document order.
 */
export function selectionRoots<T>(
  items: TreeNode<T>[],
  ids: string[],
): string[] {
  const selected = new Set(ids);
  const flat = flattenTree(items);
  const byId = new Map(flat.map((node) => [node.id, node]));
  const hasSelectedAncestor = (node: FlattenedNode<T>): boolean => {
    let parent = node.parentId;
    while (parent) {
      if (selected.has(parent)) return true;
      parent = byId.get(parent)?.parentId ?? null;
    }
    return false;
  };
  return flat
    .filter((node) => selected.has(node.id) && !hasSelectedAncestor(node))
    .map((node) => node.id);
}

/**
 * Move a whole selection together: all selection roots (deduped, document
 * order) become consecutive children of `parentId` starting at `index`. Built
 * on `applyMove`, so each subtree stays intact. Use for multi-select drag.
 */
export function applyGroupMove<T>(
  items: TreeNode<T>[],
  movingIds: string[],
  parentId: string | null,
  index: number,
): TreeNode<T>[] {
  const roots = selectionRoots(items, movingIds);
  let result = items;
  let insertAt = index;
  for (const id of roots) {
    result = applyMove(result, { id, parentId, index: insertAt });
    const placed = childIndexOf(result, parentId, id);
    insertAt = (placed < 0 ? insertAt : placed) + 1;
  }
  return result;
}
