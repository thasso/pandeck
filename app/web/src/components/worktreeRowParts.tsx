/**
 * Shared pieces of every worktree ROW: the Worktrees inbox card, the Project
 * page and the Projects browser all use the same three-axis summary, while the
 * relation surfaces also share line deltas, the merged badge, linked-session
 * paging and expansion memory. The hosts still own their density and hierarchy.
 */
import type { WorktreeGitStatus } from "@assistant/shared";
import type { WorktreeAxes } from "../lib/worktreeAxes.ts";

export function WorktreeLineDelta({
  status,
}: {
  status: WorktreeGitStatus | undefined;
}) {
  if (!status?.dirty) return null;
  const title = `${status.filesChanged + status.untracked} changed file${status.filesChanged + status.untracked === 1 ? "" : "s"}`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 font-mono text-micro font-semibold"
      title={title}
    >
      <span className="text-emerald-400">+{status.additions}</span>
      <span className="text-red-400">−{status.deletions}</span>
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
    <span className="shrink-0 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-micro font-medium text-emerald-500">
      merged
    </span>
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
      className={`relative inline-block min-w-0 max-w-full truncate align-bottom font-mono text-micro tabular-nums text-faint ${dim}`}
    >
      {axes.base ? (
        <span
          data-worktree-axis="base"
          className="mr-2 last:mr-0"
          title={`This branch is ${axisDivergence(axes.base.ahead, axes.base.behind, axes.base.label)}${staleNote}`}
        >
          <span className="text-muted">{axes.base.label}</span>{" "}
          {axes.base.ahead > 0 ? (
            <span className="text-emerald-400">↑{axes.base.ahead}</span>
          ) : null}
          {axes.base.behind > 0 ? (
            <span className="text-amber-400">↓{axes.base.behind}</span>
          ) : null}
        </span>
      ) : null}
      {axes.baseUpstream ? (
        <>
          {/* A plain whitespace-only sr-only node is dropped from Chromium's
              accessibility tree; NBSP survives without adding visual width. */}
          {axes.base ? <span className="sr-only">{"\u00a0"}</span> : null}
          <span
            data-worktree-axis="base-upstream"
            className="mr-2 last:mr-0"
            title={`${baseLabel} is ${axisDivergence(axes.baseUpstream.ahead, axes.baseUpstream.behind, axes.baseUpstream.label)}${staleNote}`}
          >
            <span className="text-muted">{axes.baseUpstream.label}</span>{" "}
            {axes.baseUpstream.ahead > 0 ? (
              <span className="text-emerald-400">
                ↑{axes.baseUpstream.ahead}
              </span>
            ) : null}
            {axes.baseUpstream.behind > 0 ? (
              <span className="text-amber-400">
                ↓{axes.baseUpstream.behind}
              </span>
            ) : null}
          </span>
        </>
      ) : null}
      {axes.upstream ? (
        <>
          {axes.base || axes.baseUpstream ? (
            <span className="sr-only">{"\u00a0"}</span>
          ) : null}
          {axes.upstream.published ? (
            <span
              data-worktree-axis="upstream"
              className="mr-2 last:mr-0"
              title={`This branch has ${pushPullDivergence(axes.upstream.ahead, axes.upstream.behind)} against ${axes.upstream.label}${staleNote}`}
            >
              <span className="text-muted">{axes.upstream.label}</span>{" "}
              {axes.upstream.ahead > 0 ? (
                <span className="text-emerald-400">↑{axes.upstream.ahead}</span>
              ) : null}
              {axes.upstream.behind > 0 ? (
                <span className="text-amber-400">↓{axes.upstream.behind}</span>
              ) : null}
            </span>
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
