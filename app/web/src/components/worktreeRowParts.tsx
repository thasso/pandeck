/**
 * Shared pieces of every worktree ROW: the Worktrees inbox card, the Project
 * page and the Projects browser all use the same three-axis summary, while the
 * relation surfaces also share line deltas, the merged badge, linked-session
 * paging and expansion memory. The hosts still own their density and hierarchy.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { GitBranch, House, MessageSquarePlus } from "lucide-react";
import type { WorktreeGitStatus, WorktreeRecord } from "@assistant/shared";
import { worktreeAxes, type WorktreeAxes } from "../lib/worktreeAxes.ts";
import { Badge } from "./ui/badge.tsx";
import { IconButton } from "./common/IconButton.tsx";
import { Tree } from "./common/Tree.tsx";

/**
 * A row's action shows on hover or focus where there is a pointer to hover
 * with, always on touch — as the session cards' and Task rows' actions do.
 * The row carries `group/row`.
 */
export const ROW_ACTION_REVEAL =
  "pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100 focus-visible:opacity-100";

/** A Project's worktrees in display order: the main checkout, then the latest. */
export function compareWorktrees(a: WorktreeRecord, b: WorktreeRecord): number {
  return (
    Number(Boolean(b.isMain)) - Number(Boolean(a.isMain)) ||
    b.updatedAt - a.updatedAt ||
    a.branch.localeCompare(b.branch)
  );
}

/**
 * One worktree as a row reads, wherever it is listed (the Projects browser,
 * the Project page): a plain glyph, the branch with its line delta and merged
 * badge pushed right, and the three-axis summary under it. The host owns the
 * row around it — selection, the click, the revealed action.
 */
export function WorktreeRowSummary({
  worktree,
  status,
  now,
  selected = false,
}: {
  worktree: WorktreeRecord;
  status?: WorktreeGitStatus | undefined;
  now: number;
  selected?: boolean;
}) {
  const branch = status?.branch ?? worktree.branch;
  const axes = worktreeAxes(worktree, status, now);
  return (
    <>
      {/* A plain glyph, not a tinted tile: the row's text carries it. */}
      <span
        className={`flex h-5 shrink-0 items-center ${selected ? "text-foreground" : "text-muted-foreground"}`}
        aria-hidden
      >
        {worktree.isMain ? <House size={16} /> : <GitBranch size={16} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
        <span className="flex min-w-0 items-center gap-1">
          <span
            className={`min-w-0 flex-1 truncate text-sm text-foreground ${selected ? "font-medium" : ""}`}
          >
            {branch}
          </span>
          <WorktreeLineDelta status={status} />
          <WorktreeMergedBadge status={status} />
        </span>
        {/* Always a second line, so every worktree row is the same height:
            the axes when one has something to say, else the calm fact. */}
        {hasAxes(axes) ? (
          <AxesSummary axes={axes} baseLabel={worktree.baseBranch} />
        ) : (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {calmLine(worktree, status)}
          </span>
        )}
      </span>
    </>
  );
}

export function WorktreeLineDelta({
  status,
}: {
  status: WorktreeGitStatus | undefined;
}) {
  if (!status?.dirty) return null;
  const title = `${status.filesChanged + status.untracked} changed file${status.filesChanged + status.untracked === 1 ? "" : "s"}`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 font-mono text-xs font-semibold"
      title={title}
    >
      <span className="text-success">+{status.additions}</span>
      <span className="text-destructive">−{status.deletions}</span>
    </span>
  );
}

/** `merged` remains a badge; unlike ahead/behind it is one semantic state. */
export function WorktreeMergedBadge({
  status,
}: {
  status: WorktreeGitStatus | undefined;
}) {
  if (!status?.merged || status.ahead <= 0) return null;
  return (
    <Badge variant="success" className="shrink-0">
      merged
    </Badge>
  );
}

/**
 * Three independent git axes. Each non-empty axis is a conditional span inside
 * one truncating run; the run ellipsizes as a whole when it does not fit and
 * disappears entirely when no axis has anything to say; `WorktreeRowSummary`
 * then says the calm fact in its place.
 */
function hasAxes(axes: WorktreeAxes): boolean {
  return Boolean(axes.base || axes.baseUpstream || axes.upstream);
}

/**
 * The second line when no axis has anything to say: before git has answered,
 * that it is being checked; after, that there is nothing to do — level with the
 * base for a branch, current with its remote for the main checkout.
 */
function calmLine(
  worktree: WorktreeRecord,
  status: WorktreeGitStatus | undefined,
): string {
  if (!status) return "checking…";
  if (worktree.isMain)
    return status.upstream?.name
      ? `up to date with ${status.upstream.name}`
      : "up to date";
  return `level with ${worktree.baseBranch || "base"}`;
}

export function AxesSummary({
  axes,
  baseLabel,
}: {
  axes: WorktreeAxes;
  baseLabel: string;
}) {
  if (!axes.base && !axes.baseUpstream && !axes.upstream) return null;
  const dim = axes.stale ? "opacity-60" : "";
  const staleNote = axes.stale ? " (remote refs may be out of date)" : "";
  return (
    <span
      data-worktree-axes
      // `relative` is load-bearing: the separators below are `sr-only`, which is
      // `position: absolute`. Without a positioned ancestor here their
      // containing block is the tree ROW, so this run's `truncate` clip does not
      // apply to them and they keep their static position out at the untruncated
      // end of the axes text — pushing the sidebar's scrollWidth ~110px past its
      // client width and letting the whole pane pan sideways on a phone.
      className={`relative inline-block min-w-0 max-w-full truncate align-bottom font-mono text-xs tabular-nums text-muted-foreground ${dim}`}
    >
      {axes.base ? (
        <Axis
          id="base"
          label={axes.base.label}
          ahead={axes.base.ahead}
          behind={axes.base.behind}
          title={`This branch is ${axisDivergence(axes.base.ahead, axes.base.behind, axes.base.label)}${staleNote}`}
        />
      ) : null}
      {axes.baseUpstream ? (
        <>
          {/* A plain whitespace-only sr-only node is dropped from Chromium's
              accessibility tree; NBSP survives without adding visual width. */}
          {axes.base ? <span className="sr-only">{"\u00a0"}</span> : null}
          <Axis
            id="base-upstream"
            label={axes.baseUpstream.label}
            ahead={axes.baseUpstream.ahead}
            behind={axes.baseUpstream.behind}
            title={`${baseLabel} is ${axisDivergence(axes.baseUpstream.ahead, axes.baseUpstream.behind, axes.baseUpstream.label)}${staleNote}`}
          />
        </>
      ) : null}
      {axes.upstream ? (
        <>
          {axes.base || axes.baseUpstream ? (
            <span className="sr-only">{"\u00a0"}</span>
          ) : null}
          {axes.upstream.published ? (
            <Axis
              id="upstream"
              label={axes.upstream.label}
              ahead={axes.upstream.ahead}
              behind={axes.upstream.behind}
              title={`This branch has ${pushPullDivergence(axes.upstream.ahead, axes.upstream.behind)} against ${axes.upstream.label}${staleNote}`}
            />
          ) : (
            <span
              data-worktree-axis="upstream"
              className="mr-2 last:mr-0"
              title="This branch has never been pushed"
            >
              unpublished
            </span>
          )}
        </>
      ) : null}
    </span>
  );
}

/** One axis: its label, then commits ahead (↑) and behind (↓). */
function Axis({
  id,
  label,
  ahead,
  behind,
  title,
}: {
  id: string;
  label: string;
  ahead: number;
  behind: number;
  title: string;
}) {
  return (
    <span data-worktree-axis={id} className="mr-2 last:mr-0" title={title}>
      {label}{" "}
      {ahead > 0 ? <span className="text-success">↑{ahead}</span> : null}
      {behind > 0 ? <span className="text-warning">↓{behind}</span> : null}
    </span>
  );
}

function axisDivergence(ahead: number, behind: number, label: string): string {
  return [
    ahead > 0 ? `${ahead} ahead of ${label}` : undefined,
    behind > 0 ? `${behind} behind ${label}` : undefined,
  ]
    .filter(Boolean)
    .join(" / ");
}

function pushPullDivergence(ahead: number, behind: number): string {
  return [
    ahead > 0 ? `${ahead} to push` : undefined,
    behind > 0 ? `${behind} to pull` : undefined,
  ]
    .filter(Boolean)
    .join(" / ");
}

export const INITIAL_SESSION_LIMIT = 5;
export const SESSION_LIMIT_STEP = 5;
const EXPANDED_WORKTREES_STORAGE_KEY = "assistant.worktreeBrowser.expanded.v1";

export function loadExpandedWorktreeIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(EXPANDED_WORKTREES_STORAGE_KEY);
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

export function persistExpandedWorktreeIds(ids: Set<string>) {
  try {
    window.localStorage.setItem(
      EXPANDED_WORKTREES_STORAGE_KEY,
      JSON.stringify([...ids]),
    );
  } catch {
    // Best-effort only; the in-memory state still applies for this render.
  }
}

interface WorktreeRowProps {
  worktree: WorktreeRecord;
  status?: WorktreeGitStatus | undefined;
  now: number;
  selected: boolean;
  onStartSession?: ((id: string) => void) | undefined;
}

function WorktreeRowImpl({
  worktree,
  status,
  now,
  selected,
  onStartSession,
}: WorktreeRowProps) {
  const branch = status?.branch ?? worktree.branch;
  return (
    // `py-0.5`: a worktree row is two lines and a little taller than the
    // tree's other rows.
    <div
      className="group/row flex min-w-0 items-start gap-1.5 py-0.5"
      title={`${branch}\n${worktree.path}`}
    >
      <WorktreeRowSummary
        worktree={worktree}
        status={status}
        now={now}
        selected={selected}
      />
      {onStartSession ? (
        <IconButton
          size="icon-sm"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onStartSession(worktree.id);
          }}
          label={`Start session in worktree: ${branch}`}
          // Centred on the row's two lines, not pinned to the first.
          className={`shrink-0 self-center ${ROW_ACTION_REVEAL}`}
        >
          <MessageSquarePlus />
        </IconButton>
      ) : null}
    </div>
  );
}

/**
 * @component WorktreeRow
 * @purpose One worktree as a `Tree` row's body, the same in the sidebar's
 *   Projects browser and on the Project page: `WorktreeRowSummary` and the
 *   start-session action revealed on hover, pinned to the first line.
 * @useWhen A `Tree` (compact, flush) lists worktrees; the tree owns the row's
 *   chrome — hover, selection, dividers, the click.
 * @intent The memo folds the shared wall clock down to the stale/fresh bit the
 *   row renders, so minute ticks do not redraw every row.
 */
export const WorktreeRow = memo(
  WorktreeRowImpl,
  (previous, next) =>
    previous.worktree === next.worktree &&
    previous.status === next.status &&
    previous.selected === next.selected &&
    previous.onStartSession === next.onStartSession &&
    worktreeAxes(previous.worktree, previous.status, previous.now).stale ===
      worktreeAxes(next.worktree, next.status, next.now).stale,
);

/**
 * @component WorktreeList
 * @purpose A flat list of worktrees on the same `Tree` and with the same
 *   `WorktreeRow` as the sidebar's Projects browser — compact, flush, in its
 *   order — wherever worktrees are listed outside it (the Project page, the
 *   inspectors), so they are one component, not several that look alike.
 * @intent No selection (a click opens the worktree), no drag.
 */
export function WorktreeList({
  worktrees,
  statuses,
  onOpen,
  onStartSession,
}: {
  worktrees: WorktreeRecord[];
  statuses: Record<string, WorktreeGitStatus>;
  onOpen?: ((id: string) => void) | undefined;
  onStartSession?: ((id: string) => void) | undefined;
}) {
  // One coarse wall clock serves every row; `WorktreeRow`'s memo folds it down
  // to the rendered stale/fresh bit, so minute ticks do not redraw siblings.
  const now = useCoarseNow(60_000);
  const items = useMemo(
    () =>
      [...worktrees]
        .sort(compareWorktrees)
        .map((worktree) => ({ id: worktree.id, data: worktree })),
    [worktrees],
  );
  return (
    <Tree
      items={items}
      compact
      flush
      showGuides={false}
      aria-label="Worktrees"
      // The last row drops its hairline: the action row under the list draws
      // the one that closes it.
      className="[&>li:last-child_.border-b]:border-b-0"
      selectedIds={NO_SELECTION}
      onSelectionChange={(ids) => {
        if (ids.length === 1) onOpen?.(ids[0]!);
      }}
      renderNode={(node) => (
        <WorktreeRow
          worktree={node.data}
          status={statuses[node.id]}
          now={now}
          selected={false}
          onStartSession={onStartSession}
        />
      )}
    />
  );
}

const NO_SELECTION: string[] = [];

function useCoarseNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
