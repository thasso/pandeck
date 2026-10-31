import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  WorktreeChangesResponse,
  WorktreeDiffScope,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { fetchWorktreeChanges } from "../lib/worktrees.ts";
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
