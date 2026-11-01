import { useCallback, type MouseEvent, type ReactNode } from "react";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../ui/item.tsx";

/** One commit as a clickable row: subject, a byline, the short oid. */
export function CommitItem({
  subject,
  shortOid,
  children,
  selected = false,
  dimmed = false,
  onClick,
}: {
  subject: string;
  shortOid: string;
  /** The byline under the subject. */
  children: ReactNode;
  selected?: boolean;
  dimmed?: boolean | undefined;
  onClick: (event: MouseEvent) => void;
}) {
  return (
    <Item
      size="xs"
      variant={selected ? "muted" : "default"}
      render={<button type="button" />}
      onClick={onClick}
      className={`flex-nowrap text-left ${dimmed ? "opacity-50" : ""}`}
    >
      <ItemMedia variant="icon">
        <GitCommitHorizontal />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span className="truncate">{subject}</span>
        </ItemTitle>
        <ItemDescription className="truncate">{children}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <span className="font-mono text-xs text-muted-foreground">
          {shortOid}
        </span>
      </ItemActions>
    </Item>
  );
}

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
    <div className="flex flex-col p-2">
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
      <ItemGroup className="gap-1">
        {log.entries.map((entry) => (
          <CommitItem
            key={entry.oid}
            subject={entry.subject}
            shortOid={entry.shortOid}
            onClick={() => onOpenCommit(entry)}
          >
            {entry.author} · {relativeTime(entry.authoredAt)}
            {entry.path !== path ? ` · as ${entry.path}` : ""}
          </CommitItem>
        ))}
      </ItemGroup>
      {log.truncated ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          Showing the {log.entries.length} most recent commits.
        </p>
      ) : null}
    </div>
  );
}
