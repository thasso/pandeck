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
  useWorktreeFileChanges,
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

function changeSetScope(
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
  // The newest request per list: an older one answering late (or failing)
  // would otherwise roll the list back over a newer answer, for good.
  const latest = useRef(new Map<string, string>());
  useEffect(() => {
    for (const { worktree, kind } of wanted) {
      const id = `${worktree.id}:${kind}`;
      const key = `${id}:${statuses[worktree.id]?.updatedAt ?? 0}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      latest.current.set(id, key);
      const settle = (entry: ChangeSetEntry) => {
        if (latest.current.get(id) !== key) return;
        setSets((current) => ({ ...current, [id]: entry }));
      };
      fetchWorktreeChanges(worktree.id, changeSetScope(worktree, kind)).then(
        (response) => settle({ key, response }),
        (error: unknown) =>
          settle({
            key,
            error: error instanceof Error ? error.message : String(error),
          }),
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
  selectedPath,
  onSelectFile,
}: {
  entry: ChangeSetEntry | undefined;
  selectedPath?: string | undefined;
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
      selectedPath={selectedPath}
      expandedDirectoryPaths={expandedDirs}
      onExpandedDirectoryPathsChange={setExpandedDirs}
      onSelectFile={(file) => onSelectFile(file.path)}
      emptyLabel="No changes."
      showChangeStats
      ariaLabel="Changed files"
    />
  );
}

export function WorktreeFilesList({
  worktree,
  selectedPath,
  refreshToken,
  onSelectFile,
}: {
  worktree: WorktreeRecord;
  selectedPath?: string | undefined;
  refreshToken: number;
  onSelectFile: (path: string) => void;
}) {
  const tree = useWorktreeFileTree({
    worktreeId: worktree.id,
    filePath: selectedPath,
    refreshToken,
  });
  const changes = useWorktreeFileChanges(worktree, refreshToken);
  return (
    <WorktreeFileTree
      tree={tree}
      changes={changes}
      selectedPath={selectedPath}
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
 * A worktree row's git actions — Commit, Push, a pull from origin or the
 * base, Remove — always listed, each disabled when its state does not call
 * for it. Outcomes travel as toasts — a sidebar row has no place to show
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
    // Every act always listed, so each row's menu reads the same; one the
    // state does not allow is disabled.
    const pushable = Boolean(
      status?.head && (!status.upstream || status.upstream.ahead > 0),
    );
    const actions: ListRowAction[] = [
      {
        id: "commit",
        label: "Commit",
        accessibleLabel: status?.dirty
          ? `Commit the changes in ${worktree.branch}`
          : "Nothing to commit",
        icon: <GitCommitHorizontal />,
        disabled: busy || !status?.dirty,
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
      },
      {
        id: "push",
        label: "Push",
        accessibleLabel: pushable
          ? `Push ${worktree.branch}`
          : "Nothing to push",
        icon: <Upload />,
        disabled: busy || !pushable,
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
      },
      {
        id: "pull-origin",
        label: "Pull from origin",
        accessibleLabel: !status?.upstream
          ? "Push the branch first"
          : status.upstream.behind > 0
            ? "Pull from origin"
            : "Nothing to pull",
        icon: <ArrowDownToLine />,
        disabled: busy || !(status?.upstream && status.upstream.behind > 0),
        onSelect: sync("pull-rebase", "Pull from origin"),
      },
      {
        id: "pull-base",
        label: worktree.isMain
          ? "Pull from base"
          : `Pull from ${worktree.baseBranch}`,
        accessibleLabel: worktree.isMain
          ? "Not for the main checkout"
          : status && status.behind > 0
            ? `Pull from ${worktree.baseBranch}`
            : `Level with ${worktree.baseBranch}`,
        icon: <RefreshCw />,
        disabled: busy || worktree.isMain || !(status && status.behind > 0),
        onSelect: sync("rebase-main", `Pull from ${worktree.baseBranch}`),
      },
    ];
    if (onRemove)
      actions.push({
        id: "remove",
        label: "Remove worktree…",
        ...(worktree.isMain
          ? { accessibleLabel: "Not for the main checkout" }
          : {}),
        icon: <Trash2 />,
        variant: "destructive",
        disabled: busy || worktree.isMain === true,
        onSelect: () => onRemove(worktree.id),
      });
    return actions;
  }, [worktree, status, onRemove, busy]);
}
