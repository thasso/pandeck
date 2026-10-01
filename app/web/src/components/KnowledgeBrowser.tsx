import { useMemo, useState } from "react";
import {
  AlertTriangle,
  File,
  FileText,
  Folder,
  Paperclip,
  RefreshCw,
} from "lucide-react";
import type { KnowledgeTreeNode } from "@assistant/shared/knowledgeBase";
import { fetchKnowledgeTree } from "../lib/knowledgeBaseApi.ts";
import { useFetchState, useReloadOnToken } from "../hooks/useFetchState.ts";
import { dataOf, errorOf, isInitialLoad, isPending } from "../lib/loadState.ts";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
} from "./ui/load.tsx";
import {
  buildKnowledgeTreeNodes,
  expandableKnowledgeTreeIds,
  knowledgeTreeOpenTarget,
  revealKnowledgeEntryExpansionIds,
  selectedKnowledgeTreeId,
  selectedKnowledgeTreeIdForPath,
  type KnowledgeBrowserTreeNode,
} from "../lib/knowledgeTree.ts";
import { Tree } from "./ui/Tree.tsx";

const INDENT_WIDTH = 12;
// The tree is one query, so its fetch key is a constant: every reload refreshes
// it in place rather than addressing a different object.
const TREE_KEY = "knowledge-tree";
// Persist which nodes the user has expanded; everything else starts collapsed.
const EXPAND_STORAGE_KEY = "assistant.knowledgeTree.expanded.v1";

/**
 * @component KnowledgeBrowser
 * @purpose Sidebar object browser for the first-class Knowledge Base: compact
 * tree rows for folders, entries, assets, loose files, and invalid entries.
 * @useWhen Rendering the Knowledge primary sidebar section.
 * @avoidWhen Displaying an entry body; use the main Knowledge route/viewer.
 * @intent Read-only app-shell navigation over the server's compact KB index;
 * generated implementation files are excluded server-side and selected routes
 * reveal their ancestors without coupling sidebar section state to the URL.
 */
export function KnowledgeBrowser({
  selectedEntryId,
  selectedEntryPath,
  selectedFilePath,
  onOpenEntry,
  onOpenInvalidEntry,
  onOpenFile,
  changedAt = 0,
}: {
  selectedEntryId?: string | null | undefined;
  /** Folder path of a path-addressed (invalid) entry open in the route. */
  selectedEntryPath?: string | null | undefined;
  /** Tree path of a non-entry file (asset/loose) open in the route. */
  selectedFilePath?: string | null | undefined;
  onOpenEntry: (entryId: string) => void;
  /** Open an invalid entry (no `kb.id`) by folder path. */
  onOpenInvalidEntry?: ((path: string) => void) | undefined;
  /** Open a non-entry file (entry asset or loose file) by its tree path. */
  onOpenFile?: ((path: string) => void) | undefined;
  /**
   * Newest committed KB change this client has heard about (`knowledgeChanged`).
   * The tree is an HTTP read model, so without this an agent creating or moving
   * an entry stayed invisible until a reload.
   */
  changedAt?: number | undefined;
}) {
  const [expandedStore, setExpandedStore] = useState<Set<string>>(() =>
    loadExpandedIds(),
  );

  // One tree, one key: every reload is a refresh of the SAME query, so the rows
  // (and the reading position over them) survive it (R2).
  const { state, reload } = useFetchState(TREE_KEY, fetchKnowledgeTree);
  const payload = dataOf(state) ?? null;
  const error = errorOf(state);

  // Mount fetches; after that a committed KB change re-reads the HTTP model,
  // without which an agent creating or moving an entry stayed invisible.
  useReloadOnToken(TREE_KEY, changedAt ?? 0, reload);

  const nodes = useMemo(
    () => buildKnowledgeTreeNodes(payload?.tree ?? []),
    [payload],
  );
  const expandableIds = useMemo(
    () => expandableKnowledgeTreeIds(nodes),
    [nodes],
  );
  const selectedId = useMemo(
    () =>
      selectedKnowledgeTreeId(payload?.tree ?? [], selectedEntryId) ??
      selectedKnowledgeTreeIdForPath(payload?.tree ?? [], selectedEntryPath) ??
      selectedKnowledgeTreeIdForPath(payload?.tree ?? [], selectedFilePath),
    [payload, selectedEntryId, selectedEntryPath, selectedFilePath],
  );
  const revealIds = useMemo(
    () => revealKnowledgeEntryExpansionIds(nodes, selectedEntryId),
    [nodes, selectedEntryId],
  );
  const expandedIds = useMemo(() => {
    // A node is open only if the user has expanded it, or reveal forces its
    // ancestors open so a routed/revealed entry is visible.
    const reveal = new Set(revealIds);
    return expandableIds.filter(
      (id) => reveal.has(id) || expandedStore.has(id),
    );
  }, [expandedStore, expandableIds, revealIds]);

  const onExpandedChange = (ids: string[]) => {
    const next = new Set(expandableIds.filter((id) => ids.includes(id)));
    setExpandedStore(next);
    persistExpandedIds(next);
  };

  if (isInitialLoad(state)) return <PaneLoading label="Loading knowledge…" />;

  if (!payload) {
    return (
      <ErrorNote
        message={`Knowledge tree unavailable: ${error ?? "not loaded"}`}
        onRetry={reload}
      />
    );
  }

  // R1: only an answered tree may say there is nothing in it.
  if (payload.tree.length === 0) {
    return (
      <EmptyBox>
        No knowledge entries yet. Create entries with the KB tools; generated
        implementation files stay hidden from this tree.
      </EmptyBox>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2 px-2 text-caption text-faint">
        <span className="min-w-0 flex-1 truncate">
          {payload.entriesCount} entr{payload.entriesCount === 1 ? "y" : "ies"}
          {payload.invalidCount > 0 ? ` · ${payload.invalidCount} invalid` : ""}
        </span>
        {isPending(state) ? (
          <RefreshIndicator label="Refreshing the Knowledge tree" />
        ) : null}
        <button
          type="button"
          onClick={reload}
          disabled={isPending(state)}
          className="rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
          title="Refresh Knowledge tree"
          aria-label="Refresh Knowledge tree"
        >
          <RefreshCw size={12} />
        </button>
      </div>
      {/* R2: the tree below stays exactly as it was; this only says it is stale. */}
      {error ? (
        <ErrorNote message={`Refresh failed: ${error}`} onRetry={reload} />
      ) : null}
      <Tree
        items={nodes}
        indentWidth={INDENT_WIDTH}
        compact
        showGuides
        aria-label="Knowledge"
        expandedIds={expandedIds}
        onExpandedChange={onExpandedChange}
        selectedIds={selectedId ? [selectedId] : []}
        onSelectionChange={(ids) => {
          if (ids.length !== 1) return;
          const target = knowledgeTreeOpenTarget(payload?.tree ?? [], ids[0]!);
          if (!target) return;
          if ("entryId" in target) onOpenEntry(target.entryId);
          else if ("filePath" in target) onOpenFile?.(target.filePath);
          else onOpenInvalidEntry?.(target.path);
        }}
        canDrag={() => false}
        renderNode={(node, rowState) => (
          <KnowledgeRow node={node} selected={rowState.selected} />
        )}
      />
    </div>
  );
}

function KnowledgeRow({
  node,
  selected,
}: {
  node: KnowledgeBrowserTreeNode;
  selected: boolean;
}) {
  const item = node.data.item;
  const icon = iconForItem(item);
  const title =
    item.type === "entry"
      ? (item.title ?? item.name)
      : item.type === "invalid-entry"
        ? item.name
        : item.name;
  const subtitle = subtitleForItem(item);
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      title={[title, subtitle, item.error].filter(Boolean).join(" — ")}
    >
      <span
        className={`flex size-5 shrink-0 items-center justify-center ${item.type === "invalid-entry" ? "text-danger" : selected ? "text-accent" : "text-muted"}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-caption text-fg">
        <span className={selected ? "font-medium" : undefined}>{title}</span>
      </span>
      {subtitle ? (
        <span className="shrink-0 truncate text-micro text-faint">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

function iconForItem(item: KnowledgeTreeNode) {
  switch (item.type) {
    case "folder":
      return <Folder size={13} />;
    case "entry":
      return <FileText size={13} />;
    case "invalid-entry":
      return <AlertTriangle size={13} />;
    case "asset":
      return <Paperclip size={13} />;
    default:
      return <File size={13} />;
  }
}

function subtitleForItem(item: KnowledgeTreeNode): string | null {
  if (item.type === "entry")
    return item.status === "archived" ? "archived" : (item.entryType ?? null);
  if (item.type === "invalid-entry") return "invalid";
  if (item.type === "asset") return "asset";
  return null;
}

function loadExpandedIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXPAND_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function persistExpandedIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Best-effort only.
  }
}
