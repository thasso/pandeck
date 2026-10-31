import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  GitCommitHorizontal,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type {
  WorktreeChangesResponse,
  WorktreeDiffScope,
  WorktreeGitStatus,
  WorktreeRecord,
  WorktreeSyncOperation,
} from "@assistant/shared";
import {
  autoCommitWorktree,
  fetchWorktreeChanges,
  pushWorktree,
  syncWorktree,
} from "../lib/worktrees.ts";
import { showToast, TOAST_DWELL_MS } from "../lib/toast.ts";
import type { ListRowAction } from "./common/ListRowActions.tsx";
import { ErrorNote, Skeleton } from "./common/load.tsx";
import {
  WorktreeFileNavigator,
  buildChangeNavigatorEntries,
  directoryPathsFromNavigatorEntries,
} from "./worktree/WorktreeFileNavigator.tsx";
import {
  WorktreeFileTree,
  useWorktreeFileTree,
} from "./worktree/WorktreeFileTree.tsx";

/**
 * The sections a worktree opens into in the Projects browser. `uncommitted` is
 * the working tree against HEAD, `changes` the branch against its base — the
 * Review tab's "Whole branch" scope.
 */
export type WorktreeSectionKind =
  "sessions" | "uncommitted" | "changes" | "files";

export type ChangeSetKind = "uncommitted" | "changes";

export function changeSetScope(
  worktree: WorktreeRecord,
  kind: ChangeSetKind,
): WorktreeDiffScope {
  return kind === "changes"
    ? { kind: "range", from: worktree.baseCommit }
    : { kind: "workingTree" };
}

type ChangeSetEntry =
  | { key: string; response: WorktreeChangesResponse }
  | { key: string; error: string };

/**
 * Change lists per worktree and kind, read for every `wanted` pair and re-read
 * when that worktree's status moves. Kept by `${worktreeId}:${kind}`: a refetch
 * leaves the previous answer up until the new one lands.
 */
export function useWorktreeChangeSets(
  wanted: ReadonlyArray<{ worktree: WorktreeRecord; kind: ChangeSetKind }>,
  statuses: Record<string, WorktreeGitStatus>,
): Record<string, ChangeSetEntry> {
  const [sets, setSets] = useState<Record<string, ChangeSetEntry>>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const { worktree, kind } of wanted) {
      const id = `${worktree.id}:${kind}`;
      const key = `${id}:${statuses[worktree.id]?.updatedAt ?? 0}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      fetchWorktreeChanges(worktree.id, changeSetScope(worktree, kind)).then(
        (response) =>
          setSets((current) => ({ ...current, [id]: { key, response } })),
        (error: unknown) =>
          setSets((current) => ({
            ...current,
            [id]: {
              key,
              error: error instanceof Error ? error.message : String(error),
            },
          })),
      );
    }
  }, [wanted, statuses]);
  return sets;
}

/** `+12 −3` in the diff colours; nothing for a side with no lines. */
export function DiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-xs font-normal">
      {additions > 0 ? (
        <span className="text-success">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="ml-1 text-destructive">−{deletions}</span>
      ) : null}
    </span>
  );
}

/**
 * Content hosted INSIDE a tree row: its clicks, presses and keys stay here, so
 * the row is neither selected nor dragged nor keyboard-navigated by them.
 */
export function RowContentHost({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-w-0 flex-1 py-0.5 pr-1"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function WorktreeChangeList({
  entry,
  onSelectFile,
}: {
  entry: ChangeSetEntry | undefined;
  onSelectFile: (path: string) => void;
}) {
  const files = entry && "response" in entry ? entry.response.files : null;
  const entries = useMemo(
    () => (files ? buildChangeNavigatorEntries(files) : []),
    [files],
  );
  const [expandedDirs, setExpandedDirs] = useState<string[]>([]);
  useEffect(() => {
    setExpandedDirs(directoryPathsFromNavigatorEntries(entries));
  }, [entries]);
  if (!entry) return <Skeleton className="my-1 h-5 w-3/4" />;
  if ("error" in entry) return <ErrorNote message={entry.error} />;
  return (
    <WorktreeFileNavigator
      entries={entries}
      expandedDirectoryPaths={expandedDirs}
      onExpandedDirectoryPathsChange={setExpandedDirs}
      onSelectFile={(file) => onSelectFile(file.path)}
      emptyLabel="No changes."
      showChangeStats
      ariaLabel="Changed files"
      viewMode="tree"
    />
  );
}

export function WorktreeFilesList({
  worktreeId,
  refreshToken,
  onSelectFile,
}: {
  worktreeId: string;
  refreshToken: number;
  onSelectFile: (path: string) => void;
}) {
  const tree = useWorktreeFileTree({ worktreeId, refreshToken });
  return (
    <WorktreeFileTree
      tree={tree}
      onSelectFile={(file) => onSelectFile(file.path)}
      ariaLabel="Worktree files"
    />
  );
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const failed = (message: string) =>
  showToast(message, { tone: "error", durationMs: TOAST_DWELL_MS });

/**
 * A worktree row's git actions, each offered only when its state calls for it:
 * Commit with changes, Push with commits to push or a branch never pushed, a
 * pull from origin or the base when behind it, and Remove for a non-main
 * worktree. Outcomes travel as toasts — a sidebar row has no place to show
 * them. A commit the review blocks is left for the worktree page.
 */
export function useWorktreeRowActions(
  worktree: WorktreeRecord,
  status: WorktreeGitStatus | undefined,
  onRemove: ((id: string) => void) | undefined,
): ListRowAction[] {
  const [busy, setBusy] = useState(false);
  return useMemo(() => {
    const run = (act: () => Promise<void>) => () => {
      setBusy(true);
      void act()
        .catch((error: unknown) => failed(errorText(error)))
        .finally(() => setBusy(false));
    };
    const sync = (operation: WorktreeSyncOperation, label: string) =>
      run(async () => {
        const result = await syncWorktree(worktree.id, operation);
        showToast(
          result.status === "up-to-date"
            ? `${label}: already up to date.`
            : `${label} completed.`,
          { tone: result.status === "updated" ? "success" : "default" },
        );
      });
    const actions: ListRowAction[] = [];
    if (status?.dirty)
      actions.push({
        id: "commit",
        label: "Commit",
        accessibleLabel: `Commit the changes in ${worktree.branch}`,
        icon: <GitCommitHorizontal />,
        disabled: busy,
        onSelect: run(async () => {
          const { result } = await autoCommitWorktree(worktree.id);
          if (result.status === "committed")
            showToast(`Committed ${result.commitHash ?? "changes"}.`, {
              tone: "success",
            });
          else
            failed(
              result.error ??
                (result.blockers.length
                  ? `Commit blocked: ${result.blockers.map((blocker) => blocker.reason).join("; ")}. Open the worktree to review.`
                  : "Nothing was committed."),
            );
        }),
      });
    if (status?.head && (!status.upstream || status.upstream.ahead > 0))
      actions.push({
        id: "push",
        label: "Push",
        accessibleLabel: `Push ${worktree.branch}`,
        icon: <Upload />,
        disabled: busy,
        onSelect: run(async () => {
          const result = await pushWorktree(worktree.id);
          if (result.status === "failed")
            failed(result.error || "Push failed.");
          else if (result.status === "up-to-date")
            showToast("Everything up to date.");
          else
            showToast(
              `Pushed ${result.branch ?? worktree.branch} → ${result.remote ?? "origin"}.`,
              { tone: "success" },
            );
        }),
      });
    if (status?.upstream && status.upstream.behind > 0)
      actions.push({
        id: "pull-origin",
        label: "Pull from origin",
        icon: <ArrowDownToLine />,
        disabled: busy,
        onSelect: sync("pull-rebase", "Pull from origin"),
      });
    if (!worktree.isMain && status && status.behind > 0)
      actions.push({
        id: "pull-base",
        label: `Pull from ${worktree.baseBranch}`,
        icon: <RefreshCw />,
        disabled: busy,
        onSelect: sync("rebase-main", `Pull from ${worktree.baseBranch}`),
      });
    if (!worktree.isMain && onRemove)
      actions.push({
        id: "remove",
        label: "Remove worktree…",
        icon: <Trash2 />,
        variant: "destructive",
        disabled: busy,
        onSelect: () => onRemove(worktree.id),
      });
    return actions;
  }, [worktree, status, onRemove, busy]);
}
