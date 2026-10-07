/**
 * Shared pieces of every worktree ROW: the Worktrees inbox card, the Project
 * page and the Projects browser all use the same three-axis summary, while the
 * relation surfaces also share line deltas, the merged badge, linked-session
 * paging and expansion memory. The hosts still own their density and hierarchy.
 */
import type { WorktreeGitStatus } from "@assistant/shared";
import type { WorktreeAxes } from "../lib/worktreeAxes.ts";
import { Badge } from "./ui/badge.tsx";

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
 * disappears entirely when no axis has anything to say, letting a calm
 * Project-page row collapse back to one line without a placeholder.
 */
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
