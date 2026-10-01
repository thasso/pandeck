/**
 * The app-wide PR/CI projection: the shape it is held in, the ONE precedence
 * every surface reads it by, and the gate keys that decide when it changed.
 *
 * This used to live inside the Worktrees inbox, which was the only surface that
 * showed PR/CI. It is app state now (`hooks/useWorktreeHosting.ts`) because a
 * Backlog row states it too, and two pollers for one projection would double
 * the provider traffic and let the two surfaces disagree.
 */
import type {
  WorktreeCiStatus,
  WorktreeHostingStatusResponse,
  WorktreePullRequestInfo,
  WorktreePullRequestReview,
} from "@assistant/shared";
import type { SidebarSection } from "../hooks/useSidebarSection.ts";

/**
 * Hosting per worktree id. A worktree the server could not resolve is ABSENT
 * rather than present-and-empty, everywhere this map travels: absence means
 * unknown, an empty entry would read as "no PR, no CI", and that is how a
 * provider outage turns into a screen full of clean-looking branches.
 */
export type WorktreeHostingMap = Record<string, WorktreeHostingStatusResponse>;

/** One shared empty map, so a surface with no projection keeps a stable prop. */
export const EMPTY_WORKTREE_HOSTING: WorktreeHostingMap = {};

/**
 * Exactly what {@link hostingAttention} may consult. `pr` is the one field the
 * ladder actually reads, so a caller holding a pull request WITHOUT a number
 * and a URL — a session's `/pr` card has neither until the provider has created
 * it (`lib/sessionDelivery.ts`) — ranks on the same rungs rather than inventing
 * a second ladder or inventing the missing fields.
 */
export interface HostingAttentionFacts {
  pr?: Pick<WorktreePullRequestInfo, "state">;
  ci?: WorktreeCiStatus;
  /** Absent = not known. `unresolvedThreads` is itself optional — see the type. */
  review?: WorktreePullRequestReview;
}

/** The same facts as a worktree CARRIES them: a whole pull request, or none. */
export interface HostingFacts extends HostingAttentionFacts {
  pr?: WorktreePullRequestInfo;
}

/**
 * What the PR and its checks are asking of you, strongest first. Deliberately
 * NOT a worktree state: it knows nothing about the working tree, the remote or
 * a merge in flight, which is what lets a Task row — which has none of those —
 * read the same ladder as the Worktrees inbox instead of inventing a second.
 *
 * `open` closes the list because a pull request that is merely open asks
 * nothing; it is still worth stating on a row that would otherwise say only
 * that a branch exists.
 */
export type HostingAttention =
  "ci-failed" | "review-requested" | "merged" | "ci-pending" | "open";

/**
 * The precedence, in one place: a red check outranks a review, a review
 * outranks the merge that ended the branch, and a running check outranks the
 * bare fact of an open PR. `classifyWorktree` interleaves its own local facts
 * (a running session, a merge in flight) between these rungs but never reorders
 * them.
 *
 * Absent CI and a CLOSED-unmerged PR both answer null: neither asks anything,
 * and reporting "checks passed" for a branch nobody proposed is noise.
 */
export function hostingAttention(
  hosting: HostingAttentionFacts | undefined,
): HostingAttention | null {
  if (!hosting) return null;
  if (hosting.ci?.state === "failure" || hosting.ci?.state === "error")
    return "ci-failed";
  if (
    hosting.pr?.state === "open" &&
    (hosting.review?.changesRequested ||
      (hosting.review?.unresolvedThreads ?? 0) > 0)
  ) {
    return "review-requested";
  }
  if (hosting.pr?.state === "merged") return "merged";
  if (hosting.ci?.state === "pending") return "ci-pending";
  if (hosting.pr?.state === "open") return "open";
  return null;
}

export function worktreeHostingMap(
  statuses: WorktreeHostingStatusResponse[],
): WorktreeHostingMap {
  return Object.fromEntries(
    statuses.map((status) => [status.worktreeId, status]),
  );
}

/**
 * Whether a freshly fetched projection SAYS anything new.
 *
 * The projection reaches the memoized sidebar and, through it, every Task row,
 * so a poll that changes its identity repaints the Backlog for nothing — and
 * this one polls on a timer, not on a change. The whole payload is the key
 * because every field of it is read by some surface; the LIST order is
 * incidental and normalized here, since the server fills it from a concurrent
 * worker pool.
 *
 * `JSON.stringify` follows each object's own key insertion order, so this also
 * leans on the server building every entry the same way each time — which it
 * does (`worktreeHostingStatus` returns one fixed shape). The cost of being
 * wrong is a repaint, never a wrong reading, so paying for a key-sorted
 * serializer to close that gap is not worth it; a normalizing key would be, if
 * these payloads ever start arriving from more than one place.
 */
export function worktreeHostingKey(
  statuses: WorktreeHostingStatusResponse[],
): string {
  return JSON.stringify(
    [...statuses].sort((a, b) => a.worktreeId.localeCompare(b.worktreeId)),
  );
}

/** Where the browser is, for {@link hostingSurfaces}. */
export interface HostingSurfaceInput {
  /** Whether the sidebar's object browser is actually on screen. */
  sidebarVisible: boolean;
  /** The SELECTED section, which survives navigating away from the browser. */
  sidebarSection: SidebarSection;
  routeName: string;
  /**
   * A project's PAGE is open, not the projects index. The Tasks section is on
   * the page (`ProjectDetailPage` renders it only for a project it resolved),
   * so the route name alone would have a window parked on the index polling a
   * provider for a surface that is not there.
   */
  projectOpen: boolean;
  /**
   * Whether the sidebar's Task rows have a SECOND LINE to state delivery on.
   * Two things decide it and the caller owns both: the rail's `tight` TREE rows
   * have none (a phone's `comfortable` ones do), while Focus rows carry one at
   * either density. A row with no second line must not make the app poll a
   * provider for something it cannot show.
   */
  sidebarTaskRowsHaveMeta: boolean;
}

export interface HostingSurfaces {
  /** Something on screen states per-worktree PR/CI. */
  hosting: boolean;
  /**
   * A Backlog surface with TWO-LINE Task rows is on screen — the sidebar's, a
   * project page's, or both. Separate from `hosting` because those rows state
   * two things the app must go and get: PR/CI, which `hosting` polls for, and
   * uncommitted changes, which App must hold a git-status WATCH for.
   */
  taskRows: boolean;
}

/**
 * What the app is showing, and therefore what it should poll for.
 *
 * The projection is app state (`hooks/useWorktreeHosting.ts`), so nothing stops
 * it from polling forever in a window parked on a conversation — one request
 * that fans out to a provider per repository, every five minutes, for a screen
 * that states none of it. The same two rules as `topicsForSurface`: the main
 * pane's ROUTE always counts, the selected SECTION only while its browser is
 * visible.
 *
 * Getting this wrong is invisible in both directions — too wide is silent
 * traffic, too narrow is a card or a row that renders perfectly and says
 * nothing — which is why it is a tested function and not a boolean expression
 * inside a component.
 */
export function hostingSurfaces({
  sidebarVisible,
  sidebarSection,
  routeName,
  projectOpen,
  sidebarTaskRowsHaveMeta,
}: HostingSurfaceInput): HostingSurfaces {
  const shownSection = sidebarVisible ? sidebarSection : null;
  // A project's PAGE carries a two-line Backlog list; its index carries none,
  // which is why the route name is not enough. The worktree SCREEN is
  // deliberately absent altogether: its Delivery panel asks for its own
  // worktree by id and does not read this map, and the Pull Requests section
  // reads its OWN inventory (`hooks/usePullRequestInventory.ts`) rather than
  // this per-worktree one.
  const taskRows =
    (routeName === "projects" && projectOpen) ||
    (shownSection === "tasks" && sidebarTaskRowsHaveMeta);
  return { hosting: taskRows, taskRows };
}
