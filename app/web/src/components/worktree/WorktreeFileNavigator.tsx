import { useCallback, useMemo } from "react";
import { ChevronLeft, ChevronRight, FileCode2, Folder } from "lucide-react";
import type {
  WorktreeChangeFile,
  WorktreeChangeStatus,
  WorktreeTreeEntry,
} from "@assistant/shared";
import { Tree, type TreeNode, type TreeNodeState } from "../ui/Tree.tsx";
import { Skeleton, Spinner } from "../ui/load.tsx";

/**
 * @component WorktreeFileNavigator
 * @purpose Reusable tree navigator for worktree file paths: changed-file trees,
 * lazy working-tree browsing, and compact inspector file summaries.
 * @useWhen A worktree surface needs folder-aware file navigation with caller-defined
 * click behavior (open a diff, open a file, or simply reveal a path).
 * @avoidWhen Rendering generic non-file hierarchies; use `components/ui/Tree` directly.
 * @intent Domain-light wrapper around the shared Tree chrome. Callers provide flat
 * file/dir entries and own loading/navigation; this component only builds the
 * folder hierarchy and reports selected file/directory entries.
 * @related components/ui/Tree.tsx, WorktreeDetailPage.tsx, objectInspectors.tsx
 */

type WorktreeNavigatorEntryKind = "file" | "dir";
export type WorktreeNavigatorViewMode = "list" | "tree";

export interface WorktreeNavigatorEntry {
  kind: WorktreeNavigatorEntryKind;
  path: string;
  name?: string;
  status?: WorktreeChangeStatus;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  size?: number;
  oldPath?: string;
  /** True when this directory can load children lazily if expanded. */
  deferred?: boolean;
}

interface NavigatorNodeData {
  kind: WorktreeNavigatorEntryKind | "placeholder";
  path: string;
  name: string;
  status?: WorktreeChangeStatus | "mixed";
  additions: number;
  deletions: number;
  files: number;
  binary?: boolean;
  size?: number;
  oldPath?: string;
  deferred?: boolean;
}

interface TreeBuildResult {
  items: TreeNode<NavigatorNodeData>[];
  byId: Map<string, NavigatorNodeData>;
}

export interface WorktreeFileNavigatorProps {
  entries: WorktreeNavigatorEntry[];
  selectedPath?: string | undefined;
  loading?: boolean;
  emptyLabel?: string;
  /** Controlled expanded directory paths. */
  expandedDirectoryPaths: string[];
  onExpandedDirectoryPathsChange: (paths: string[]) => void;
  /** Directory paths whose children have been loaded. Undefined = all dirs known. */
  loadedDirectoryPaths?: string[];
  loadingDirectoryPaths?: string[];
  /** Called before/while expanding a lazy directory. */
  onLoadDirectory?: (path: string) => void;
  onSelectFile: (entry: WorktreeNavigatorEntry) => void;
  onSelectDirectory?: (entry: WorktreeNavigatorEntry) => void;
  compact?: boolean;
  showChangeStats?: boolean;
  className?: string;
  ariaLabel?: string;
  /** List by default; tree mode preserves an expandable folder hierarchy. */
  viewMode?: WorktreeNavigatorViewMode;
  /**
   * When defined in list mode, show only this directory's immediate children.
   * Pair with onListDirectoryPathChange for drill-down/back navigation. Omit to
   * retain the flat all-entries list used by changed-file navigators.
   */
  listDirectoryPath?: string | undefined;
  onListDirectoryPathChange?: ((path: string) => void) | undefined;
}

const ROOT_DIR = "";

function entryName(path: string): string {
  if (!path) return "/";
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function dirId(path: string): string {
  return `dir:${path || "/"}`;
}

function fileId(path: string): string {
  return `file:${path}`;
}

function placeholderId(path: string): string {
  return `placeholder:${path || "/"}`;
}

function entryFromData(data: NavigatorNodeData): WorktreeNavigatorEntry {
  return {
    kind: data.kind === "dir" ? "dir" : "file",
    path: data.path,
    name: data.name,
    ...(!(data.status === "mixed") ? { status: data.status } : {}),
    additions: data.additions,
    deletions: data.deletions,
    ...(data.binary !== undefined ? { binary: data.binary } : {}),
    ...(data.size !== undefined ? { size: data.size } : {}),
    ...(data.oldPath !== undefined ? { oldPath: data.oldPath } : {}),
    ...(data.deferred !== undefined ? { deferred: data.deferred } : {}),
  };
}

function dataFromEntry(entry: WorktreeNavigatorEntry): NavigatorNodeData {
  return {
    kind: entry.kind,
    path: entry.path,
    name: entry.name ?? entryName(entry.path),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    additions: entry.additions ?? 0,
    deletions: entry.deletions ?? 0,
    files: entry.kind === "file" ? 1 : 0,
    ...(entry.binary !== undefined ? { binary: entry.binary } : {}),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
    ...(entry.deferred !== undefined ? { deferred: entry.deferred } : {}),
  };
}

function uniqueSortedEntries(
  entries: WorktreeNavigatorEntry[],
): WorktreeNavigatorEntry[] {
  const byPath = new Map<string, WorktreeNavigatorEntry>();
  for (const entry of entries) byPath.set(`${entry.kind}:${entry.path}`, entry);
  return [...byPath.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function newDirNode(
  path: string,
  deferred: boolean,
): TreeNode<NavigatorNodeData> {
  return {
    id: dirId(path),
    data: {
      kind: "dir",
      path,
      name: entryName(path),
      additions: 0,
      deletions: 0,
      files: 0,
      deferred,
    },
    children: [],
  };
}

function sortNodes(
  a: TreeNode<NavigatorNodeData>,
  b: TreeNode<NavigatorNodeData>,
): number {
  if (a.data.kind === "placeholder") return 1;
  if (b.data.kind === "placeholder") return -1;
  if (a.data.kind !== b.data.kind) return a.data.kind === "dir" ? -1 : 1;
  return a.data.name.localeCompare(b.data.name);
}

function aggregate(node: TreeNode<NavigatorNodeData>): {
  additions: number;
  deletions: number;
  files: number;
  statuses: Set<WorktreeChangeStatus>;
} {
  if (node.data.kind === "file") {
    const statuses = new Set<WorktreeChangeStatus>();
    if (node.data.status && node.data.status !== "mixed")
      statuses.add(node.data.status);
    return {
      additions: node.data.additions,
      deletions: node.data.deletions,
      files: 1,
      statuses,
    };
  }
  const total = {
    additions: 0,
    deletions: 0,
    files: 0,
    statuses: new Set<WorktreeChangeStatus>(),
  };
  for (const child of node.children ?? []) {
    if (child.data.kind === "placeholder") continue;
    const childTotal = aggregate(child);
    total.additions += childTotal.additions;
    total.deletions += childTotal.deletions;
    total.files += childTotal.files;
    for (const status of childTotal.statuses) total.statuses.add(status);
  }
  node.data.additions = total.additions;
  node.data.deletions = total.deletions;
  node.data.files = total.files;
  if (total.statuses.size === 1) node.data.status = [...total.statuses][0]!;
  else if (total.statuses.size > 1) node.data.status = "mixed";
  return total;
}

function collectById(
  nodes: TreeNode<NavigatorNodeData>[],
  byId: Map<string, NavigatorNodeData>,
) {
  for (const node of nodes) {
    byId.set(node.id, node.data);
    collectById(node.children ?? [], byId);
  }
}

function buildNodes(
  entries: WorktreeNavigatorEntry[],
  loadedDirectoryPaths: Set<string> | null,
): TreeBuildResult {
  const root = newDirNode(ROOT_DIR, false);
  const dirs = new Map<string, TreeNode<NavigatorNodeData>>([[ROOT_DIR, root]]);

  const ensureDir = (
    path: string,
    deferred = false,
  ): TreeNode<NavigatorNodeData> => {
    const existing = dirs.get(path);
    if (existing) {
      existing.data.deferred = existing.data.deferred || deferred;
      return existing;
    }
    const parent = ensureDir(parentPath(path));
    const node = newDirNode(path, deferred);
    dirs.set(path, node);
    parent.children = [...(parent.children ?? []), node];
    return node;
  };

  for (const entry of entries) {
    if (entry.kind === "dir") {
      const loaded = loadedDirectoryPaths?.has(entry.path) ?? true;
      const node = ensureDir(entry.path, entry.deferred ?? !loaded);
      node.data = {
        ...node.data,
        name: entry.name ?? entryName(entry.path),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        deferred: entry.deferred ?? !loaded,
      };
      continue;
    }
    const parent = ensureDir(parentPath(entry.path));
    parent.children = [
      ...(parent.children ?? []),
      {
        id: fileId(entry.path),
        data: {
          kind: "file",
          path: entry.path,
          name: entry.name ?? entryName(entry.path),
          ...(entry.status !== undefined ? { status: entry.status } : {}),
          additions: entry.additions ?? 0,
          deletions: entry.deletions ?? 0,
          files: 1,
          ...(entry.binary !== undefined ? { binary: entry.binary } : {}),
          ...(entry.size !== undefined ? { size: entry.size } : {}),
          ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
        },
      },
    ];
  }

  const applyPlaceholders = (node: TreeNode<NavigatorNodeData>) => {
    if (
      node.data.kind === "dir" &&
      node.data.deferred &&
      (node.children ?? []).length === 0
    ) {
      node.children = [
        {
          id: placeholderId(node.data.path),
          data: {
            kind: "placeholder",
            path: node.data.path,
            // Never drawn — `NavigatorRow` renders a skeleton for a placeholder
            // — but the node model requires a name, and this is what it means.
            name: "Loading…",
            additions: 0,
            deletions: 0,
            files: 0,
          },
        },
      ];
    } else {
      for (const child of node.children ?? []) applyPlaceholders(child);
    }
    node.children = [...(node.children ?? [])].sort(sortNodes);
  };
  applyPlaceholders(root);
  for (const child of root.children ?? []) aggregate(child);

  const items = [...(root.children ?? [])].sort(sortNodes);
  const byId = new Map<string, NavigatorNodeData>();
  collectById(items, byId);
  return { items, byId };
}

export function buildChangeNavigatorEntries(
  files: WorktreeChangeFile[],
): WorktreeNavigatorEntry[] {
  return files.map((file) => ({
    kind: "file",
    path: file.path,
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
  }));
}

export function buildLoadedTreeNavigatorEntries(
  entriesByDir: Record<string, WorktreeTreeEntry[]>,
): WorktreeNavigatorEntry[] {
  const entries: WorktreeNavigatorEntry[] = [];
  for (const list of Object.values(entriesByDir)) {
    for (const entry of list) {
      entries.push({
        kind: entry.kind,
        path: entry.path,
        name: entry.name,
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      });
    }
  }
  return entries;
}

/**
 * Drop cached directories their parent's CURRENT listing no longer contains.
 *
 * The tree cache is refreshed directory by directory in place, so a folder that
 * was deleted upstream would keep its own cached children on screen under a
 * parent that has stopped listing it. A directory whose parent has not been
 * loaded at all is kept: during a deep-link load a child can answer before its
 * ancestors, and that is not a vanished folder.
 */
export function pruneVanishedTreeDirs(
  entriesByDir: Record<string, WorktreeTreeEntry[]>,
): Record<string, WorktreeTreeEntry[]> {
  const next = { ...entriesByDir };
  const dropped = new Set<string>();
  // Shallowest first, so a removed folder's descendants follow it out.
  const dirs = Object.keys(next).sort(
    (a, b) => a.split("/").length - b.split("/").length,
  );
  for (const dir of dirs) {
    if (dir === ROOT_DIR) continue;
    const parent = parentPath(dir);
    const listing = next[parent];
    const gone = dropped.has(parent)
      ? true
      : listing !== undefined &&
        !listing.some((entry) => entry.kind === "dir" && entry.path === dir);
    if (gone) {
      delete next[dir];
      dropped.add(dir);
    }
  }
  return dropped.size > 0 ? next : entriesByDir;
}

export function directoryPathsFromNavigatorEntries(
  entries: WorktreeNavigatorEntry[],
): string[] {
  const dirs = new Set<string>();
  for (const entry of entries) {
    let current = entry.kind === "dir" ? entry.path : parentPath(entry.path);
    while (current) {
      dirs.add(current);
      current = parentPath(current);
    }
  }
  return [...dirs].sort();
}

export function ancestorDirectoryPaths(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts
    .map((_, index) => parts.slice(0, index + 1).join("/"))
    .filter(Boolean);
}

function statusClass(status: NavigatorNodeData["status"]): string {
  if (status === "deleted") return "text-red-400";
  if (status === "added" || status === "untracked") return "text-emerald-400";
  if (status) return "text-amber-400";
  return "text-faint";
}

function statusGlyph(status: NavigatorNodeData["status"]): string {
  if (!status) return "";
  if (status === "mixed") return "±";
  return status.slice(0, 1);
}

/** Row widths that read as a file list rather than a block of equal bars. */
const SKELETON_ROW_WIDTHS = [
  "w-40",
  "w-28",
  "w-36",
  "w-24",
  "w-32",
  "w-20",
] as const;

/**
 * Placeholder rows at the height and rhythm of real ones, so the rail holds its
 * layout while a directory answers (R4). The region announces; the blocks are
 * decorative.
 */
function NavigatorSkeletonRows({
  label,
  rows = SKELETON_ROW_WIDTHS.length,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-0.5 p-1">
      {SKELETON_ROW_WIDTHS.slice(0, rows).map((width, index) => (
        <div key={index} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton className="size-3.5 shrink-0" />
          <Skeleton className={`h-3 ${width}`} />
        </div>
      ))}
    </div>
  );
}

function ChangeStats({
  data,
  isDir,
}: {
  data: NavigatorNodeData;
  isDir: boolean;
}) {
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-micro text-faint">
      {isDir ? <span>{data.files}</span> : null}
      {data.additions > 0 ? (
        <span className="ml-1 text-emerald-400">+{data.additions}</span>
      ) : null}
      {data.deletions > 0 ? (
        <span className="ml-1 text-red-400">−{data.deletions}</span>
      ) : null}
    </span>
  );
}

function NavigatorRow({
  node,
  state,
  showChangeStats,
  loading,
}: {
  node: TreeNode<NavigatorNodeData>;
  state: TreeNodeState;
  showChangeStats: boolean;
  loading: boolean;
}) {
  const data = node.data;
  // A lazily expanding directory's children, before they arrive: one skeleton
  // row at a row's height keeps the tree from jumping when they land.
  if (data.kind === "placeholder") {
    return (
      <span
        role="status"
        aria-label="Loading folder"
        className="flex items-center gap-2"
      >
        <Skeleton className="h-3 w-28" />
      </span>
    );
  }
  const isDir = data.kind === "dir";
  return (
    <span
      className={`flex min-w-0 items-center gap-2 text-caption ${state.selected ? "text-fg" : "text-muted-foreground"}`}
      title={data.path}
    >
      {isDir ? (
        <Folder size={13} className="shrink-0 text-faint" />
      ) : (
        <FileCode2 size={13} className="shrink-0 text-faint" />
      )}
      {showChangeStats && !isDir ? (
        <span
          className={`w-3 shrink-0 text-center font-mono text-micro font-bold uppercase ${statusClass(data.status)}`}
        >
          {statusGlyph(data.status)}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{data.name}</span>
      {loading ? <Spinner size="sm" className="text-faint" /> : null}
      {showChangeStats &&
      (data.files > 0 || data.additions > 0 || data.deletions > 0) ? (
        <ChangeStats data={data} isDir={isDir} />
      ) : data.size != null && !isDir ? (
        <span className="shrink-0 font-mono text-micro text-faint">
          {data.size.toLocaleString()}
        </span>
      ) : null}
    </span>
  );
}

function NavigatorListRow({
  entry,
  selected,
  showChangeStats,
  showParentPath,
  directoryDrillDown,
  loading,
  onSelect,
}: {
  entry: WorktreeNavigatorEntry;
  selected: boolean;
  showChangeStats: boolean;
  showParentPath: boolean;
  directoryDrillDown: boolean;
  loading: boolean;
  onSelect: () => void;
}) {
  const data = dataFromEntry(entry);
  const isDir = data.kind === "dir";
  const dir = parentPath(data.path);
  return (
    <button
      type="button"
      onClick={onSelect}
      title={data.path || "/"}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left ${selected ? "bg-accent/70 text-fg" : "text-muted-foreground hover:bg-raised hover:text-fg"}`}
    >
      {isDir ? (
        <Folder size={13} className="shrink-0 text-faint" />
      ) : (
        <FileCode2 size={13} className="shrink-0 text-faint" />
      )}
      {showChangeStats && !isDir ? (
        <span
          className={`w-3 shrink-0 text-center font-mono text-micro font-bold uppercase ${statusClass(data.status)}`}
        >
          {statusGlyph(data.status)}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-caption">{data.name}</span>
        {showParentPath && dir ? (
          <span className="block truncate font-mono text-micro text-faint">
            {dir}
          </span>
        ) : null}
      </span>
      {loading ? <Spinner size="sm" className="text-faint" /> : null}
      {isDir && directoryDrillDown && !loading ? (
        <ChevronRight size={13} className="shrink-0 text-faint" />
      ) : null}
      {showChangeStats &&
      (data.files > 0 || data.additions > 0 || data.deletions > 0) ? (
        <ChangeStats data={data} isDir={isDir} />
      ) : data.size != null && !isDir ? (
        <span className="shrink-0 font-mono text-micro text-faint">
          {data.size.toLocaleString()}
        </span>
      ) : null}
    </button>
  );
}

export function WorktreeFileNavigator({
  entries,
  selectedPath,
  loading = false,
  emptyLabel = "No files.",
  expandedDirectoryPaths,
  onExpandedDirectoryPathsChange,
  loadedDirectoryPaths,
  loadingDirectoryPaths = [],
  onLoadDirectory,
  onSelectFile,
  onSelectDirectory,
  compact = true,
  showChangeStats = false,
  className,
  ariaLabel = "Worktree files",
  viewMode = "list",
  listDirectoryPath,
  onListDirectoryPathChange,
}: WorktreeFileNavigatorProps) {
  const loadedSet = useMemo(
    () => (loadedDirectoryPaths ? new Set(loadedDirectoryPaths) : null),
    [loadedDirectoryPaths],
  );
  const loadingSet = useMemo(
    () => new Set(loadingDirectoryPaths),
    [loadingDirectoryPaths],
  );
  const { items, byId } = useMemo(
    () => buildNodes(entries, loadedSet),
    [entries, loadedSet],
  );
  const expandedIds = useMemo(
    () => expandedDirectoryPaths.map(dirId),
    [expandedDirectoryPaths],
  );
  const listNavigatesDirectories =
    listDirectoryPath !== undefined && onListDirectoryPathChange !== undefined;
  const listEntries = useMemo(() => {
    const sorted = uniqueSortedEntries(entries);
    return listDirectoryPath === undefined
      ? sorted
      : sorted.filter((entry) => parentPath(entry.path) === listDirectoryPath);
  }, [entries, listDirectoryPath]);

  const expandDirectory = useCallback(
    (path: string, next: boolean) => {
      const set = new Set(expandedDirectoryPaths);
      if (next) set.add(path);
      else set.delete(path);
      onExpandedDirectoryPathsChange([...set].sort());
      if (
        next &&
        onLoadDirectory &&
        loadedSet !== null &&
        !loadedSet.has(path) &&
        !loadingSet.has(path)
      )
        onLoadDirectory(path);
    },
    [
      expandedDirectoryPaths,
      loadedSet,
      loadingSet,
      onExpandedDirectoryPathsChange,
      onLoadDirectory,
    ],
  );

  const handleExpandedChange = useCallback(
    (ids: string[]) => {
      const nextPaths = ids
        .map((id) => byId.get(id))
        .filter(
          (data): data is NavigatorNodeData =>
            data !== undefined && data.kind === "dir",
        )
        .map((data) => data.path);
      onExpandedDirectoryPathsChange(nextPaths.sort());
      for (const path of nextPaths) {
        if (
          onLoadDirectory &&
          loadedSet !== null &&
          !loadedSet.has(path) &&
          !loadingSet.has(path)
        )
          onLoadDirectory(path);
      }
    },
    [
      byId,
      loadedSet,
      loadingSet,
      onExpandedDirectoryPathsChange,
      onLoadDirectory,
    ],
  );

  const handleSelectionChange = useCallback(
    (ids: string[]) => {
      const id = ids.at(-1);
      if (!id) return;
      const data = byId.get(id);
      if (!data || data.kind === "placeholder") return;
      if (data.kind === "dir") {
        const isExpanded = expandedDirectoryPaths.includes(data.path);
        expandDirectory(data.path, !isExpanded);
        onSelectDirectory?.(entryFromData(data));
        return;
      }
      onSelectFile(entryFromData(data));
    },
    [
      byId,
      expandDirectory,
      expandedDirectoryPaths,
      onSelectDirectory,
      onSelectFile,
    ],
  );

  const handleListSelect = useCallback(
    (entry: WorktreeNavigatorEntry) => {
      if (entry.kind === "dir") {
        const set = new Set(expandedDirectoryPaths);
        set.add(entry.path);
        onExpandedDirectoryPathsChange([...set].sort());
        if (
          onLoadDirectory &&
          loadedSet !== null &&
          !loadedSet.has(entry.path) &&
          !loadingSet.has(entry.path)
        )
          onLoadDirectory(entry.path);
        onListDirectoryPathChange?.(entry.path);
        onSelectDirectory?.(entry);
        return;
      }
      onSelectFile(entry);
    },
    [
      expandedDirectoryPaths,
      loadedSet,
      loadingSet,
      onExpandedDirectoryPathsChange,
      onListDirectoryPathChange,
      onLoadDirectory,
      onSelectDirectory,
      onSelectFile,
    ],
  );

  if (loading) return <NavigatorSkeletonRows label="Loading files" />;
  if (entries.length === 0 || items.length === 0)
    return (
      <div className="px-2 py-4 text-caption text-faint">{emptyLabel}</div>
    );

  if (viewMode === "list") {
    const currentDirectoryLoading =
      listNavigatesDirectories && loadingSet.has(listDirectoryPath);
    return (
      <div role="list" aria-label={ariaLabel} className={className}>
        {listNavigatesDirectories && listDirectoryPath ? (
          <button
            type="button"
            title={`Back to ${parentPath(listDirectoryPath) || "root"}`}
            aria-label={`Back to ${parentPath(listDirectoryPath) || "root"}`}
            onClick={() =>
              onListDirectoryPathChange(parentPath(listDirectoryPath))
            }
            className="mb-1 flex w-full min-w-0 items-center gap-2 rounded-lg border-b border-line/70 px-2 py-2 text-left text-muted-foreground hover:bg-raised hover:text-fg"
          >
            <ChevronLeft size={14} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono text-caption">
              {listDirectoryPath}
            </span>
          </button>
        ) : null}
        {currentDirectoryLoading && listEntries.length === 0 ? (
          <NavigatorSkeletonRows label="Loading folder" rows={4} />
        ) : listEntries.length === 0 ? (
          <div className="px-2 py-4 text-caption text-faint">{emptyLabel}</div>
        ) : (
          listEntries.map((entry) => (
            <NavigatorListRow
              key={`${entry.kind}:${entry.path}`}
              entry={entry}
              selected={entry.path === selectedPath}
              showChangeStats={showChangeStats}
              showParentPath={!listNavigatesDirectories}
              directoryDrillDown={listNavigatesDirectories}
              loading={entry.kind === "dir" && loadingSet.has(entry.path)}
              onSelect={() => handleListSelect(entry)}
            />
          ))
        )}
      </div>
    );
  }

  return (
    <Tree<NavigatorNodeData>
      items={items}
      expandedIds={expandedIds}
      onExpandedChange={handleExpandedChange}
      selectedIds={selectedPath ? [fileId(selectedPath)] : []}
      onSelectionChange={handleSelectionChange}
      compact={compact}
      showGuides
      indentWidth={18}
      className={className}
      aria-label={ariaLabel}
      renderNode={(node, state) => (
        <NavigatorRow
          node={node}
          state={state}
          showChangeStats={showChangeStats}
          loading={node.data.kind === "dir" && loadingSet.has(node.data.path)}
        />
      )}
    />
  );
}
