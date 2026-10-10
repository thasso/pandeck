import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeTreeEntry } from "@assistant/shared";
import { ErrorNote } from "../common/load.tsx";
import { useReloadOnToken } from "../../hooks/useFetchState.ts";
import { fetchWorktreeTree } from "../../lib/worktrees.ts";
import {
  WorktreeFileNavigator,
  ancestorDirectoryPaths,
  buildLoadedTreeNavigatorEntries,
  pruneVanishedTreeDirs,
  type WorktreeNavigatorEntry,
  type WorktreeNavigatorViewMode,
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
  const [expandedDirs, setExpandedDirs] = useState<string[]>(() =>
    filePath ? ancestorDirectoryPaths(filePath) : [],
  );
  const [listDirectory, setListDirectory] = useState(() =>
    filePath ? splitWorktreePath(filePath).dir : "",
  );
  const [includeIgnored, setIncludeIgnored] = useState(false);
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
    setListDirectory("");
    setTreeError(null);
    loadDirectory("", true);
  }, [loadDirectory]);

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
  // cache first dropped `rootLoaded` to skeleton rows and threw list mode back
  // to the repo root on every scan.
  const refreshTree = useCallback(() => {
    const dirs = loadedDirsRef.current;
    for (const dir of dirs.length > 0 ? dirs : [""]) loadDirectory(dir, true);
  }, [loadDirectory]);
  useReloadOnToken(worktreeId, refreshToken, refreshTree);

  useEffect(() => {
    if (!filePath) return;
    const ancestors = ancestorDirectoryPaths(filePath);
    setListDirectory(splitWorktreePath(filePath).dir);
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
    setExpandedDirs,
    listDirectory,
    setListDirectory,
    includeIgnored,
    setIncludeIgnored,
    treeError,
    loadDirectory,
  };
}

export type WorktreeFileTreeState = ReturnType<typeof useWorktreeFileTree>;

/**
 * The navigator over a `useWorktreeFileTree` cache, with its per-directory
 * error and retry: the worktree Files rail and the Knowledge sidebar draw this.
 */
export function WorktreeFileTree({
  tree,
  selectedPath,
  onSelectFile,
  viewMode = "tree",
  ariaLabel,
  compact,
}: {
  tree: WorktreeFileTreeState;
  selectedPath?: string | undefined;
  onSelectFile: (entry: WorktreeNavigatorEntry) => void;
  viewMode?: WorktreeNavigatorViewMode;
  ariaLabel: string;
  compact?: boolean;
}) {
  const { treeError, rootLoaded } = tree;
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
          entries={tree.entries}
          selectedPath={selectedPath}
          // Not "a root request is in flight": until the root has ANSWERED the
          // tree is loading, so an empty first frame can never read as an
          // empty worktree (R1).
          loading={!rootLoaded}
          expandedDirectoryPaths={tree.expandedDirs}
          onExpandedDirectoryPathsChange={tree.setExpandedDirs}
          loadedDirectoryPaths={tree.loadedDirs}
          loadingDirectoryPaths={tree.loadingDirs}
          onLoadDirectory={tree.loadDirectory}
          listDirectoryPath={
            viewMode === "list" ? tree.listDirectory : undefined
          }
          onListDirectoryPathChange={
            viewMode === "list" ? tree.setListDirectory : undefined
          }
          onSelectFile={onSelectFile}
          emptyLabel="No files."
          ariaLabel={ariaLabel}
          viewMode={viewMode}
          {...(compact !== undefined ? { compact } : {})}
        />
      ) : null}
    </div>
  );
}
