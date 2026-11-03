import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorktreeChangeFile,
  WorktreeChangeStatus,
  WorktreeRecord,
  WorktreeTreeEntry,
} from "@assistant/shared";
import { ErrorNote } from "../common/load.tsx";
import { useReloadOnToken } from "../../hooks/useFetchState.ts";
import {
  fetchWorktreeChanges,
  fetchWorktreeTree,
} from "../../lib/worktrees.ts";
import { useIgnoredFilesShown } from "../../lib/worktreeIgnoredFiles.ts";
import {
  loadExpandedTreeDirs,
  saveExpandedTreeDirs,
} from "../../lib/worktreeTreeExpansion.ts";
import {
  WorktreeFileNavigator,
  ancestorDirectoryPaths,
  buildLoadedTreeNavigatorEntries,
  pruneVanishedTreeDirs,
  type WorktreeNavigatorEntry,
} from "./WorktreeFileNavigator.tsx";

export function splitWorktreePath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/**
 * A worktree's file tree as a lazily filled CACHE of directories: the root on
 * open, a folder when it is expanded, and every ancestor of `filePath` so the
 * open file is always visible. Refreshes in place when `refreshToken` moves.
 */
export function useWorktreeFileTree({
  worktreeId,
  filePath,
  refreshToken,
}: {
  worktreeId: string;
  filePath?: string | undefined;
  /** The worktree status's `updatedAt`: a watcher push re-reads the tree. */
  refreshToken: number;
}) {
  const [entriesByDir, setEntriesByDir] = useState<
    Record<string, WorktreeTreeEntry[]>
  >({});
  const [loadingDirs, setLoadingDirs] = useState<string[]>([]);
  // The folders left open last time (remembered per worktree), plus the open
  // file's own.
  const [expandedDirs, setExpandedDirs] = useState<string[]>(() => [
    ...new Set([
      ...loadExpandedTreeDirs(worktreeId),
      ...(filePath ? ancestorDirectoryPaths(filePath) : []),
    ]),
  ]);
  // The reader's own folding is what is remembered, not the unfolding to a file.
  const setExpandedDirsRemembered = useCallback(
    (dirs: string[]) => {
      setExpandedDirs(dirs);
      saveExpandedTreeDirs(worktreeId, dirs);
    },
    [worktreeId],
  );
  // Shared by every tree of this worktree (`lib/worktreeIgnoredFiles.ts`).
  const [includeIgnored, setIncludeIgnored] = useIgnoredFilesShown(worktreeId);
  const includeIgnoredRef = useRef(includeIgnored);
  includeIgnoredRef.current = includeIgnored;
  // The tree keeps its own error, against the DIRECTORY that failed: a folder
  // that fails to expand must not take the file (or the rest of the tree) down
  // with it, and the retry has to reload that folder rather than the root.
  const [treeError, setTreeError] = useState<{
    dir: string;
    message: string;
  } | null>(null);

  // Directories with a request out. Refreshing re-reads every loaded directory,
  // so without this a run of watcher pushes would pile duplicate reads of the
  // same folder onto the git queue; an answer that is one scan behind is close
  // enough, and the next push re-reads anyway.
  const inFlightDirs = useRef(new Set<string>());
  const worktreeIdRef = useRef(worktreeId);
  worktreeIdRef.current = worktreeId;
  // Bumped when the worktree or visibility mode changes, so an older read
  // cannot land its listing in the current tree.
  const treeGeneration = useRef(0);

  const loadDirectory = useCallback(
    (dir: string, force = false) => {
      setEntriesByDir((current) => {
        if (!force && current[dir]) return current;
        if (inFlightDirs.current.has(dir)) return current;
        inFlightDirs.current.add(dir);
        const generation = treeGeneration.current;
        const stillThisTree = () => treeGeneration.current === generation;
        setLoadingDirs((loading) =>
          loading.includes(dir) ? loading : [...loading, dir],
        );
        fetchWorktreeTree(worktreeId, dir, includeIgnoredRef.current)
          .then((payload) => {
            if (!stillThisTree()) return;
            setTreeError((error) => (error?.dir === dir ? null : error));
            // A fresh listing can also say a subdirectory is GONE, and its own
            // cached children would otherwise keep showing under it.
            setEntriesByDir((next) =>
              pruneVanishedTreeDirs({ ...next, [dir]: payload }),
            );
          })
          .catch((err) => {
            if (!stillThisTree()) return;
            setTreeError({
              dir,
              message: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            if (!stillThisTree()) return;
            inFlightDirs.current.delete(dir);
            setLoadingDirs((loading) => loading.filter((item) => item !== dir));
          });
        return current;
      });
    },
    [worktreeId],
  );

  // A DIFFERENT worktree is a different object, so its tree starts empty (R3).
  // Keyed on `loadDirectory`, which changes with the worktree id alone.
  useEffect(() => {
    treeGeneration.current += 1;
    inFlightDirs.current.clear();
    setEntriesByDir({});
    setLoadingDirs([]);
    setTreeError(null);
    setExpandedDirs(loadExpandedTreeDirs(worktreeIdRef.current));
    loadDirectory("", true);
  }, [loadDirectory]);

  // Remembered folders load level by level: each once its parent's listing
  // shows it still exists, so one deleted since never reads as a failure.
  useEffect(() => {
    for (const dir of expandedDirs) {
      if (dir === "" || entriesByDir[dir] || inFlightDirs.current.has(dir))
        continue;
      const parent = splitWorktreePath(dir).dir;
      if (
        entriesByDir[parent]?.some(
          (entry) => entry.kind === "dir" && entry.path === dir,
        )
      )
        loadDirectory(dir);
    }
  }, [expandedDirs, entriesByDir, loadDirectory]);

  // Which directories the cache holds, readable from refreshes without making
  // them re-run on every answer.
  const loadedDirsRef = useRef<string[]>([]);
  const previousTreeConfig = useRef({ worktreeId, includeIgnored });

  // A visibility change keeps the current rows and expanded directories while
  // every loaded directory is replaced with a listing in the new mode. Bumping
  // the generation prevents a slower answer from the previous mode landing.
  useEffect(() => {
    const previous = previousTreeConfig.current;
    previousTreeConfig.current = { worktreeId, includeIgnored };
    if (previous.worktreeId !== worktreeId) return;
    if (previous.includeIgnored === includeIgnored) return;

    const dirs = [
      ...new Set([...loadedDirsRef.current, ...inFlightDirs.current]),
    ];
    treeGeneration.current += 1;
    inFlightDirs.current.clear();
    setLoadingDirs([]);
    for (const dir of dirs.length > 0 ? dirs : [""]) loadDirectory(dir, true);
  }, [includeIgnored, loadDirectory, worktreeId]);

  // A watcher push invalidates the tree IN PLACE (R2): every directory already
  // loaded is refetched and swapped in when it answers, so the rows, the
  // expansion and the folder you are standing in all survive. Clearing the
  // cache first dropped `rootLoaded` to skeleton rows.
  const refreshTree = useCallback(() => {
    const dirs = loadedDirsRef.current;
    for (const dir of dirs.length > 0 ? dirs : [""]) loadDirectory(dir, true);
  }, [loadDirectory]);
  useReloadOnToken(worktreeId, refreshToken, refreshTree);

  useEffect(() => {
    if (!filePath) return;
    const ancestors = ancestorDirectoryPaths(filePath);
    setExpandedDirs((current) =>
      [...new Set([...current, ...ancestors])].sort(),
    );
    for (const dir of ["", ...ancestors]) loadDirectory(dir);
  }, [filePath, loadDirectory]);

  const entries = useMemo(
    () => buildLoadedTreeNavigatorEntries(entriesByDir),
    [entriesByDir],
  );
  const loadedDirs = useMemo(() => Object.keys(entriesByDir), [entriesByDir]);
  loadedDirsRef.current = loadedDirs;

  return {
    entries,
    loadedDirs,
    loadingDirs,
    rootLoaded: entriesByDir[""] !== undefined,
    expandedDirs,
    setExpandedDirs: setExpandedDirsRemembered,
    includeIgnored,
    setIncludeIgnored,
    treeError,
    loadDirectory,
  };
}

export type WorktreeFileTreeState = ReturnType<typeof useWorktreeFileTree>;

/**
 * What the branch changed, for the file browser to mark: the working tree
 * against the base (the Review tab's "Whole branch"), or against HEAD on a
 * main checkout, which has no base of its own. Re-read when the status moves.
 */
export function useWorktreeFileChanges(
  worktree: WorktreeRecord,
  refreshToken: number,
): readonly WorktreeChangeFile[] | undefined {
  const [files, setFiles] = useState<WorktreeChangeFile[]>();
  useEffect(() => {
    let cancelled = false;
    fetchWorktreeChanges(
      worktree.id,
      worktree.isMain
        ? { kind: "workingTree" }
        : { kind: "range", from: worktree.baseCommit },
    ).then(
      (response) => {
        if (!cancelled) setFiles(response.files);
      },
      // Marks are a nicety over the tree: a failed read leaves it unmarked.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [worktree.id, worktree.isMain, worktree.baseCommit, refreshToken]);
  return files;
}

/**
 * The loaded tree with the change set laid over it: changed files carry their
 * status and line counts, folders whose listing is not loaded carry their
 * totals, and deleted files (and folders) — which no listing has — are put
 * back where they were. A deleted folder's contents are all known, so it is
 * reported as loaded and never asks the server for a listing it cannot give.
 */
function overlayChanges(
  entries: WorktreeNavigatorEntry[],
  loadedDirs: string[],
  changes: readonly WorktreeChangeFile[],
): { entries: WorktreeNavigatorEntry[]; syntheticDirs: string[] } {
  const byPath = new Map(changes.map((file) => [file.path, file]));
  const marked = entries.map((entry) => {
    if (entry.kind === "file") {
      const change = byPath.get(entry.path);
      return change
        ? {
            ...entry,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
          }
        : entry;
    }
    const prefix = `${entry.path}/`;
    let additions = 0;
    let deletions = 0;
    let files = 0;
    const statuses = new Set<WorktreeChangeStatus>();
    for (const change of changes) {
      if (!change.path.startsWith(prefix)) continue;
      additions += change.additions;
      deletions += change.deletions;
      files += 1;
      statuses.add(change.status);
    }
    if (files === 0) return entry;
    return {
      ...entry,
      additions,
      deletions,
      files,
      status: statuses.size === 1 ? [...statuses][0]! : "modified",
    } satisfies WorktreeNavigatorEntry;
  });

  const present = new Set(marked.map((entry) => `${entry.kind}:${entry.path}`));
  const known = new Set(loadedDirs);
  const syntheticDirs: string[] = [];
  const added: WorktreeNavigatorEntry[] = [];
  for (const change of changes) {
    if (change.status !== "deleted") continue;
    const parts = change.path.split("/");
    let reachable = true;
    for (let index = 1; index < parts.length && reachable; index += 1) {
      const dir = parts.slice(0, index).join("/");
      const parent = parts.slice(0, index - 1).join("/");
      if (!known.has(parent)) reachable = false;
      else if (present.has(`dir:${dir}`)) reachable = known.has(dir);
      else {
        // Listed parent, no such folder: it went with its files.
        present.add(`dir:${dir}`);
        known.add(dir);
        syntheticDirs.push(dir);
        added.push({ kind: "dir", path: dir, status: "deleted" });
      }
    }
    const parent = parts.slice(0, -1).join("/");
    if (reachable && known.has(parent) && !present.has(`file:${change.path}`)) {
      present.add(`file:${change.path}`);
      added.push({
        kind: "file",
        path: change.path,
        status: "deleted",
        additions: change.additions,
        deletions: change.deletions,
      });
    }
  }
  return { entries: [...marked, ...added], syntheticDirs };
}

/**
 * The navigator over a `useWorktreeFileTree` cache, with its per-directory
 * error and retry: the worktree Files rail and the Knowledge sidebar draw this.
 */
export function WorktreeFileTree({
  tree,
  selectedPath,
  onSelectFile,
  ariaLabel,
  compact,
  changes,
}: {
  tree: WorktreeFileTreeState;
  /** The branch's changes, marked on the files (`useWorktreeFileChanges`). */
  changes?: readonly WorktreeChangeFile[] | undefined;
  selectedPath?: string | undefined;
  onSelectFile: (entry: WorktreeNavigatorEntry) => void;
  ariaLabel: string;
  compact?: boolean;
}) {
  const { treeError, rootLoaded } = tree;
  const overlay = useMemo(
    () =>
      changes && changes.length > 0
        ? overlayChanges(tree.entries, tree.loadedDirs, changes)
        : { entries: tree.entries, syntheticDirs: [] },
    [changes, tree.entries, tree.loadedDirs],
  );
  const loadedDirectoryPaths = useMemo(
    () =>
      overlay.syntheticDirs.length > 0
        ? [...tree.loadedDirs, ...overlay.syntheticDirs]
        : tree.loadedDirs,
    [overlay.syntheticDirs, tree.loadedDirs],
  );
  return (
    <div className="flex flex-col gap-2">
      {treeError !== null ? (
        <ErrorNote
          message={
            treeError.dir === ""
              ? `Could not load the file tree: ${treeError.message}`
              : `Could not load “${treeError.dir}”: ${treeError.message}`
          }
          onRetry={() => tree.loadDirectory(treeError.dir, true)}
        />
      ) : null}
      {/* An errored, never-answered root has nothing to say: the note above is
        the whole state, and "No files." would be a claim about the worktree
        (R1). */}
      {rootLoaded || treeError === null ? (
        <WorktreeFileNavigator
          entries={overlay.entries}
          selectedPath={selectedPath}
          // Not "a root request is in flight": until the root has ANSWERED the
          // tree is loading, so an empty first frame can never read as an
          // empty worktree (R1).
          loading={!rootLoaded}
          expandedDirectoryPaths={tree.expandedDirs}
          onExpandedDirectoryPathsChange={tree.setExpandedDirs}
          loadedDirectoryPaths={loadedDirectoryPaths}
          loadingDirectoryPaths={tree.loadingDirs}
          onLoadDirectory={tree.loadDirectory}
          onSelectFile={onSelectFile}
          emptyLabel="No files."
          ariaLabel={ariaLabel}
          {...(compact !== undefined ? { compact } : {})}
        />
      ) : null}
    </div>
  );
}
