/**
 * Pure shaping for a worktree ROW's three-axis git summary: the worktree
 * against its base branch, the base branch against its own remote, and the
 * worktree branch against its own remote.
 *
 * What is left of a bigger module. This used to shape the whole Worktrees inbox
 * — the delivery ladder, attention tiers, the ordering, card actions — and that
 * surface is gone: the sidebar section it lived in is Pull Requests now, and a
 * worktree is browsed on its Project page. The axes stayed because the Project
 * page's worktree rows and the Projects tree still draw them, through
 * `components/worktreeRowParts.tsx`.
 *
 * The contract that survived with them is the load-bearing one: an ABSENT
 * status is UNKNOWN, never clean. A group with nothing to say is `undefined`
 * rather than a row of zeros, so the renderer omits the span instead of
 * inventing one.
 */
import type { WorktreeGitStatus, WorktreeRecord } from "@assistant/shared";

/** Beyond this, the remote-tracking refs are old enough to say so. */
const STALE_FETCH_MS = 15 * 60_000;

/**
 * Facts that are true alongside any state, so they render regardless of which
 * one won. Module-private: `behindBase` and `noUpstream` are read off the axes
 * themselves now, and only staleness still crosses the boundary — on the axes.
 */
interface WorktreeModifiers {
  /** Commits the base branch has that this one does not. */
  behindBase: number;
  /** The remote-tracking refs are old enough that the axes may be wrong. */
  staleFetch: boolean;
  /** Never pushed: distinct from "in sync", and not a zero. */
  noUpstream: boolean;
}

function worktreeModifiers(
  worktree: WorktreeRecord,
  status: WorktreeGitStatus | undefined,
  now: number,
): WorktreeModifiers {
  const fetchedAt = status?.fetchedAt;
  return {
    behindBase: worktree.isMain ? 0 : Math.max(0, status?.behind ?? 0),
    // Unknown is not fresh: a status with no fetch stamp cannot claim currency.
    staleFetch:
      Boolean(status) && (!fetchedAt || now - fetchedAt > STALE_FETCH_MS),
    noUpstream: Boolean(status) && !status?.upstream,
  };
}

/**
 * The three axes answer independent questions: the worktree versus the base
 * branch, the base branch versus its own remote, and the worktree branch versus
 * its own remote. Each axis is a conditionally omitted span inside one
 * truncating run, which ellipsizes as a whole when it does not fit. A main
 * checkout's upstream relationship is included and shown now rather than
 * hidden.
 *
 * A group is `undefined` when it has nothing to say, so the renderer can omit
 * that span without inventing zeros.
 */
export interface WorktreeAxes {
  /** vs the base branch: work to merge back, and whether the base moved. */
  base?: { label: string; ahead: number; behind: number };
  /** vs the base branch's tracked remote: whether the local base drifted. */
  baseUpstream?: { label: string; ahead: number; behind: number };
  /** vs the worktree branch's tracked remote. `published: false` = never pushed. */
  upstream?: {
    label: string;
    ahead: number;
    behind: number;
    published: boolean;
  };
  /** True when the remote-facing groups use possibly-old remote refs. */
  stale: boolean;
}

export function worktreeAxes(
  worktree: WorktreeRecord,
  status: WorktreeGitStatus | undefined,
  now: number,
): WorktreeAxes {
  const modifiers = worktreeModifiers(worktree, status, now);
  const axes: WorktreeAxes = { stale: modifiers.staleFetch };
  if (!status) return axes;

  // A main checkout IS the base branch, so that axis is meaningless there and
  // rendering `main ↑0 ↓0` on it would be noise pretending to be information.
  if (!worktree.isMain && (status.ahead > 0 || status.behind > 0)) {
    axes.base = {
      label: worktree.baseBranch || "base",
      ahead: status.ahead,
      behind: status.behind,
    };
  }
  if (
    !worktree.isMain &&
    status.baseUpstream &&
    (status.baseUpstream.ahead > 0 || status.baseUpstream.behind > 0)
  ) {
    axes.baseUpstream = {
      // Older servers do not carry `name`; say which relationship this is
      // without fabricating a remote that Git never resolved.
      label: status.baseUpstream.name ?? "base upstream",
      ahead: status.baseUpstream.ahead,
      behind: status.baseUpstream.behind,
    };
  }
  if (!status.upstream) {
    axes.upstream = {
      label: "upstream",
      ahead: 0,
      behind: 0,
      published: false,
    };
  } else if (status.upstream.ahead > 0 || status.upstream.behind > 0) {
    axes.upstream = {
      label: status.upstream.name ?? "upstream",
      ahead: status.upstream.ahead,
      behind: status.upstream.behind,
      published: true,
    };
  }
  return axes;
}
