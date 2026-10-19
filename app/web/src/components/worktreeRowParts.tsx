/**
 * Shared pieces of every worktree ROW: the Worktrees inbox card, the Project
 * page and the Projects browser all use the same three-axis summary, while the
 * relation surfaces also share line deltas, the Integrated badge, linked-session
 * paging and expansion memory. The hosts still own their density and hierarchy.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRight, GitBranch, House, MessageSquarePlus } from "lucide-react";
import type {
  SessionPullRequestSummary,
  WorktreeGitStatus,
  WorktreeHostingStatusResponse,
  WorktreeRecord,
} from "@assistant/shared";
import type { WorktreeHostingMap } from "../lib/worktreeHosting.ts";
import { followRowLink } from "../lib/rowLink.ts";
import { worktreeAxes, type WorktreeAxes } from "../lib/worktreeAxes.ts";
import { usePerfRenderCount } from "../lib/perfStats.ts";
import { Badge } from "./ui/badge.tsx";
import { ListRowContent } from "./common/ListRow.tsx";
import { ListRowActions } from "./common/ListRowActions.tsx";
import type { RowDensity } from "../lib/rowDensity.ts";
import { Tree } from "./common/Tree.tsx";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { IntegratedBadge } from "./IntegratedBadge.tsx";
import { persistentStore } from "../lib/persistentStore.ts";

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
 * the Project page): branch above session disclosure and git signals, with an
 * optional first line grouping badges and line changes. The host owns selection,
 * navigation and hierarchy; ListRowActions owns action geometry.
 */
function WorktreeRowSummary({
  worktree,
  status,
  hosting,
  now,
  selected,
  density = "tight",
  sessionCount = 0,
  expanded = false,
  onToggleSessions,
  onStartSession,
}: WorktreeRowProps) {
  const branch = status?.branch ?? worktree.branch;
  const axes = worktreeAxes(worktree, status, now);
  const pullRequest: SessionPullRequestSummary | undefined = hosting?.pr
    ? {
        status: hosting.pr.state,
        number: hosting.pr.number,
        ...(hosting.ci ? { ci: hosting.ci } : {}),
        ...(hosting.review ? { review: hosting.review } : {}),
        ...(worktree.pullRequest?.number === hosting.pr.number
          ? {
              ...(worktree.pullRequest.draft !== undefined
                ? { draft: worktree.pullRequest.draft }
                : {}),
              ...(worktree.pullRequest.conflicts !== undefined
                ? { conflicts: worktree.pullRequest.conflicts }
                : {}),
            }
          : {}),
      }
    : worktree.pullRequest;
  const prMark = pullRequest ? (
    <SessionDeliveryMark
      session={{ pullRequest }}
      variant="reference"
    />
  ) : null;
  const integrated = Boolean(status?.merged && status.ahead > 0);
  const showContext = Boolean(pullRequest || status?.dirty || integrated);
  return (
    <ListRowContent
      density={density}
      actionSpan="all"
      context={showContext ? (
        <>
          {prMark ? (
            hosting?.pr?.url ? (
              <a
                href={hosting.pr.url}
                target="_blank"
                rel="noreferrer"
                draggable={false}
                aria-label={`Open PR #${hosting.pr.number}`}
                className="inline-flex shrink-0 hover:underline"
                onClick={(event) =>
                  followRowLink(event, event.currentTarget.href)
                }
                onKeyDown={(event) => event.stopPropagation()}
              >
                {prMark}
              </a>
            ) : (
              <span className="inline-flex shrink-0">{prMark}</span>
            )
          ) : null}
          {integrated ? <IntegratedBadge /> : null}
          <WorktreeLineDelta status={status} />
        </>
      ) : undefined}
      identity={
        <>
          <span className={`flex size-4 shrink-0 items-center justify-center ${selected ? "text-foreground" : "text-muted-foreground"}`} aria-hidden>
            {worktree.isMain ? <House size={16} /> : <GitBranch size={16} />}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {branch}
          </span>
        </>
      }
      signals={
        <>
          {sessionCount > 0 && onToggleSessions ? (
            <Badge
              variant="ghost"
              render={<button type="button" />}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} sessions in ${branch}`}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onToggleSessions(worktree.id);
              }}
              className="h-auto shrink-0 cursor-pointer border-0 px-0 py-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              <ChevronRight size={12} className={expanded ? "rotate-90" : ""} aria-hidden />
              Sessions <span>{sessionCount}</span>
            </Badge>
          ) : null}
          <span className="flex min-w-0 flex-1 basis-0">
            {hasAxes(axes) ? (
              <AxesSummary axes={axes} baseLabel={worktree.baseBranch} />
            ) : (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {calmLine(worktree, status)}
              </span>
            )}
          </span>
        </>
      }
      actions={onStartSession ? (
        <ListRowActions
          alwaysVisible={selected}
          actions={[{
            id: "start-session",
            label: `Start session in worktree: ${branch}`,
            icon: <MessageSquarePlus />,
            onSelect: () => onStartSession(worktree.id),
          }]}
        />
      ) : undefined}
    />
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

function AxesSummary({
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
    const raw = persistentStore().getItem(EXPANDED_WORKTREES_STORAGE_KEY);
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
    persistentStore().setItem(
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
  hosting?: WorktreeHostingStatusResponse | undefined;
  density?: RowDensity;
  sessionCount?: number;
  expanded?: boolean;
  onToggleSessions?: (id: string) => void;
  onStartSession?: ((id: string) => void) | undefined;
}

function WorktreeRowImpl(props: WorktreeRowProps) {
  usePerfRenderCount("WorktreeRow");
  const branch = props.status?.branch ?? props.worktree.branch;
  return (
    <div
      className="group/item flex min-w-0"
      title={`${branch}\n${props.worktree.path}`}
    >
      <WorktreeRowSummary {...props} />
    </div>
  );
}

/**
 * @component WorktreeRow
 * @purpose One worktree as a `Tree` row's body, the same in the sidebar's
 *   Projects browser and on the Project page: `ListRowContent` and shared
 *   actions spanning every line, including optional badge/change context.
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
    previous.hosting === next.hosting &&
    previous.selected === next.selected &&
    previous.density === next.density &&
    previous.sessionCount === next.sessionCount &&
    previous.expanded === next.expanded &&
    previous.onToggleSessions === next.onToggleSessions &&
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
  hosting,
  onOpen,
  onStartSession,
}: {
  worktrees: WorktreeRecord[];
  statuses: Record<string, WorktreeGitStatus>;
  hosting?: WorktreeHostingMap | undefined;
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
      paddedContent={false}
      getRowDisclosure={() => false}
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
          hosting={hosting?.[node.id]}
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
