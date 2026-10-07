import { useCallback } from "react";
import { GitCommitHorizontal } from "lucide-react";
import type { WorktreeFileLogEntry } from "@assistant/shared";
import { useFetchState, useReloadOnToken } from "../../hooks/useFetchState.ts";
import { fetchWorktreeFileLog } from "../../lib/worktrees.ts";
import { dataOf, errorOf, isInitialLoad } from "../../lib/loadState.ts";
import { relativeTime } from "../../lib/sessionRows.ts";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
} from "../common/load.tsx";

/**
 * @component FileHistoryList
 * @purpose A worktree file's History pivot: the commits reachable from HEAD
 * that touched it, newest first and across renames. Each row opens that
 * commit's own change to the file in Changes (`parentOid..oid`).
 * @useWhen The worktree file view's History pivot is on screen.
 */
export function FileHistoryList({
  worktreeId,
  path,
  refreshToken,
  onOpenCommit,
}: {
  worktreeId: string;
  path: string;
  /** Bumps when the worktree changed, so a new commit appears. */
  refreshToken: number;
  onOpenCommit: (entry: WorktreeFileLogEntry) => void;
}) {
  const key = `${worktreeId}\n${path}`;
  const { state, reload } = useFetchState(
    key,
    useCallback(
      () => fetchWorktreeFileLog(worktreeId, path),
      [worktreeId, path],
    ),
  );
  useReloadOnToken(key, refreshToken, reload);
  const log = dataOf(state);
  const error = errorOf(state);
  if (isInitialLoad(state)) return <PaneLoading label="Loading history…" />;
  if (!log)
    return (
      <ErrorNote
        className="m-4"
        message={`Could not load this file's history: ${error ?? "not loaded"}`}
        onRetry={reload}
      />
    );
  if (log.entries.length === 0)
    return (
      <div className="p-4">
        <EmptyBox>No commits touch this file yet.</EmptyBox>
      </div>
    );
  return (
    <div className="flex flex-col gap-px p-2">
      {state.status === "refreshing" ? (
        <div className="mb-1 flex justify-end">
          <RefreshIndicator label="Refreshing the history" />
        </div>
      ) : null}
      {/* R2: the history stays usable while a failed refresh says so. */}
      {error !== undefined ? (
        <ErrorNote
          className="mb-1"
          message={`Could not refresh this file's history: ${error}`}
          onRetry={reload}
        />
      ) : null}
      {log.entries.map((entry) => (
        <button
          key={entry.oid}
          type="button"
          onClick={() => onOpenCommit(entry)}
          className="flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left text-muted-foreground hover:bg-raised hover:text-fg"
        >
          <GitCommitHorizontal
            size={13}
            className="mt-0.5 shrink-0 text-faint"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-caption font-medium">
              {entry.subject}
            </span>
            <span className="block truncate text-micro text-faint">
              {entry.author} · {relativeTime(entry.authoredAt)}
              {entry.path !== path ? ` · as ${entry.path}` : ""}
            </span>
          </span>
          <span className="shrink-0 font-mono text-micro text-faint">
            {entry.shortOid}
          </span>
        </button>
      ))}
      {log.truncated ? (
        <p className="px-2 py-1.5 text-micro text-faint">
          Showing the {log.entries.length} most recent commits.
        </p>
      ) : null}
    </div>
  );
}
