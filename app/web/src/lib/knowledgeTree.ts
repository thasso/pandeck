import type { KnowledgeTreeNode } from "@assistant/shared/knowledgeBase";

interface KnowledgeTreeNodeData {
  item: KnowledgeTreeNode;
}

export interface KnowledgeBrowserTreeNode {
  id: string;
  data: KnowledgeTreeNodeData;
  children?: KnowledgeBrowserTreeNode[];
}

function knowledgeTreeNodeId(item: KnowledgeTreeNode): string {
  if (item.type === "entry" && item.entryId) return `entry:${item.entryId}`;
  return `${item.type}:${item.path || item.name}`;
}

export function entryTreeNodeId(entryId: string): string {
  return `entry:${entryId}`;
}

export function buildKnowledgeTreeNodes(
  items: KnowledgeTreeNode[],
): KnowledgeBrowserTreeNode[] {
  return items.map((item) => ({
    id: knowledgeTreeNodeId(item),
    data: { item },
    children: buildKnowledgeTreeNodes(item.children ?? []),
  }));
}

export function selectedKnowledgeTreeId(
  items: KnowledgeTreeNode[],
  entryId: string | null | undefined,
): string | null {
  if (!entryId) return null;
  return findEntry(items, entryId)?.id ?? null;
}

/** Node id for a path-addressed node (e.g. an invalid entry with no `entryId`). */
export function selectedKnowledgeTreeIdForPath(
  items: KnowledgeTreeNode[],
  path: string | null | undefined,
): string | null {
  if (!path) return null;
  const found = findByPath(items, path);
  return found ? knowledgeTreeNodeId(found) : null;
}

/**
 * Resolve what a selected tree node opens: a valid entry id, an invalid entry's
 * folder path, or a non-entry file (entry asset or loose file) by tree path.
 */
export function knowledgeTreeOpenTarget(
  items: KnowledgeTreeNode[],
  nodeId: string,
): { entryId: string } | { path: string } | { filePath: string } | null {
  const item = findByNodeId(items, nodeId);
  if (!item) return null;
  if (item.type === "entry" && item.entryId) return { entryId: item.entryId };
  if (item.type === "invalid-entry") return { path: item.path };
  if (item.type === "asset" || item.type === "file")
    return { filePath: item.path };
  return null;
}

export function expandableKnowledgeTreeIds(
  items: KnowledgeBrowserTreeNode[],
): string[] {
  const ids: string[] = [];
  const visit = (node: KnowledgeBrowserTreeNode) => {
    if (node.children?.length) ids.push(node.id);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of items) visit(node);
  return ids;
}

/** Expand every ancestor (and the entry itself when it has children) so a routed entry is visible. */
export function revealKnowledgeEntryExpansionIds(
  items: KnowledgeBrowserTreeNode[],
  entryId: string | null | undefined,
): string[] {
  if (!entryId) return [];
  const targetId = entryTreeNodeId(entryId);
  const path: KnowledgeBrowserTreeNode[] = [];
  const visit = (nodes: KnowledgeBrowserTreeNode[]): boolean => {
    for (const node of nodes) {
      path.push(node);
      if (node.id === targetId) return true;
      if (visit(node.children ?? [])) return true;
      path.pop();
    }
    return false;
  };
  if (!visit(items)) return [];
  return path
    .filter(
      (node, index) =>
        index < path.length - 1 || Boolean(node.children?.length),
    )
    .filter((node) => Boolean(node.children?.length))
    .map((node) => node.id);
}

function findEntry(
  items: KnowledgeTreeNode[],
  entryId: string,
): { item: KnowledgeTreeNode; id: string } | null {
  for (const item of items) {
    if (item.type === "entry" && item.entryId === entryId)
      return { item, id: knowledgeTreeNodeId(item) };
    const child = findEntry(item.children ?? [], entryId);
    if (child) return child;
  }
  return null;
}

function findByPath(
  items: KnowledgeTreeNode[],
  path: string,
): KnowledgeTreeNode | null {
  for (const item of items) {
    if (item.path === path) return item;
    const child = findByPath(item.children ?? [], path);
    if (child) return child;
  }
  return null;
}

function findByNodeId(
  items: KnowledgeTreeNode[],
  nodeId: string,
): KnowledgeTreeNode | null {
  for (const item of items) {
    if (knowledgeTreeNodeId(item) === nodeId) return item;
    const child = findByNodeId(item.children ?? [], nodeId);
    if (child) return child;
  }
  return null;
}
