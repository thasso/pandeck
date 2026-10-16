/**
 * Pure shaping for the Pull Requests browser (no React, no fetches): which
 * group a pull request belongs to, how a group is ordered, what the search box
 * matches, and the vocabulary a row and the detail page state CI, review and
 * mergeability in.
 *
 * It exists for the same reason `worktreeInbox.ts` did before it: the
 * interesting rules here are invisible when they are wrong. A row that quietly
 * claims CI passed, a conflict rendered from a provider that has not finished
 * computing one, or a list that reshuffles under the reader because its order
 * was never total, all render perfectly.
 *
 * ONE contract runs through all of it, the same one the wire states: an ABSENT
 * field means UNKNOWN, never a negative answer. `unknown` is a value here, and
 * no branch below may collapse it into "fine".
 */
import type {
  GitHostingProviderKind,
  PullRequestInventoryItem,
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import type { LoadState } from "./loadState.ts";
import {
  failed,
  idle,
  loading,
  ready,
  refreshing,
  dataOf,
} from "./loadState.ts";

/**
 * The groups, in the order they are rendered.
 *
 * `needs-review` leads because somebody else is blocked on it; `cleanup` trails
 * because the work is over and only a checkout is left. A TEAM request sits
 * below your own work: it asks a group, often for every pull request in the
 * repository (a CODEOWNERS rule), so it is the one group that can run to dozens
 * of rows and the browser collapses it. The ids are stable — they key the
 * sections' headings and the tests below.
 */
export type PullRequestGroupId =
  "needs-review" | "yours" | "assigned" | "team-review" | "cleanup";

export interface PullRequestGroupMeta {
  id: PullRequestGroupId;
  title: string;
  /** What the group is, for its empty/assistive wording. */
  description: string;
}

/** Every reason group, in render order. */
export const PULL_REQUEST_GROUP_IDS: readonly PullRequestGroupId[] = [
  "needs-review",
  "yours",
  "assigned",
  "team-review",
  "cleanup",
];

/** How the list is grouped: by the strongest reason, by project, by when. */
export type PullRequestGroupBy = "reason" | "project" | "date";

export function normalizePullRequestGroupBy(
  value: unknown,
): PullRequestGroupBy {
  if (value === "project" || value === "date") return value;
  // The former "Flat" view was already ordered by date.
  return value === "none" ? "date" : "reason";
}

/** Date bands, newest first; `unknown` (no `updatedAt`) sorts last. */
const DATE_BANDS = [
  { id: "today", title: "Today" },
  { id: "yesterday", title: "Yesterday" },
  { id: "week", title: "This week" },
  { id: "month", title: "This month" },
  { id: "older", title: "Older" },
  { id: "unknown", title: "Date unknown" },
] as const;

type DateBand = (typeof DATE_BANDS)[number]["id"];

/** Which band an update time falls in, against local midnight of `now`. */
function dateBandOf(updatedAt: number | undefined, now: number): DateBand {
  if (updatedAt === undefined) return "unknown";
  const day = 86_400_000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  if (updatedAt >= today) return "today";
  if (updatedAt >= today - day) return "yesterday";
  if (updatedAt >= today - 6 * day) return "week";
  if (updatedAt >= today - 29 * day) return "month";
  return "older";
}

/** The list's browser-local view: grouping and filters (`Prefs`). */
export interface PullRequestListView {
  groupBy: PullRequestGroupBy;
  /** The one project shown; null = all. */
  projectId: string | null;
  /** Reasons shown, by each row's strongest one. All of them = no filter. */
  reasons: readonly PullRequestGroupId[];
  hideDrafts: boolean;
}

export const DEFAULT_PULL_REQUEST_VIEW: PullRequestListView = {
  groupBy: "reason",
  projectId: null,
  reasons: PULL_REQUEST_GROUP_IDS,
  hideDrafts: false,
};

/** Whether the reason filter leaves anything out. */
export function reasonFilterActive(
  reasons: readonly PullRequestGroupId[],
): boolean {
  return PULL_REQUEST_GROUP_IDS.some((id) => !reasons.includes(id));
}

/** How many filters narrow the list — the filter button's badge. */
export function pullRequestFilterCount(view: PullRequestListView): number {
  return (
    (view.projectId !== null ? 1 : 0) +
    (reasonFilterActive(view.reasons) ? 1 : 0) +
    (view.hideDrafts ? 1 : 0)
  );
}

export const PULL_REQUEST_GROUPS: readonly PullRequestGroupMeta[] = [
  {
    id: "needs-review",
    title: "Needs your review",
    description: "Your review was requested",
  },
  { id: "yours", title: "Yours", description: "Pull requests you opened" },
  {
    id: "assigned",
    title: "Assigned to you",
    description: "Pull requests you are an assignee of",
  },
  {
    id: "team-review",
    title: "Team review requests",
    description: "A team you are in was asked to review",
  },
  {
    id: "cleanup",
    title: "Needs cleanup",
    description: "Finished upstream, still checked out locally",
  },
];

/**
 * Which group a pull request belongs to: its STRONGEST reason, in the order
 * the groups are rendered.
 *
 * A terminal pull request is ALWAYS cleanup: the server inventories one only
 * while a local worktree still holds its head branch, so its whole reason for
 * being listed is the checkout. Among open ones a review request outranks
 * authorship — your own pull request that someone also asked you to review is
 * still work somebody is waiting on, and it must not hide in "Yours" — and a
 * team request is the weakest claim on you. The other reasons stay visible on
 * the row and the page (`pullRequestReasons`).
 */
export function classifyPullRequest(
  item: PullRequestInventoryItem,
): PullRequestGroupId {
  if (item.state !== "open") return "cleanup";
  if (item.reviewRequested) return "needs-review";
  if (item.mine) return "yours";
  if (item.assignedToMe) return "assigned";
  if (item.teamReviewRequests?.length) return "team-review";
  // Nothing the server selects on is set — an older snapshot. Listed by the
  // server as yours, so it stays where it always was.
  return "yours";
}

export type PullRequestReasonKind =
  "review-requested" | "author" | "assignee" | "team-review" | "local-worktree";

export interface PullRequestReason {
  kind: PullRequestReasonKind;
  /** The sentence, for the page. */
  label: string;
  /** A word or two, for a row badge. */
  short: string;
}

/**
 * EVERY reason this pull request is in your list, strongest first — the
 * answer to "why am I seeing this?". The group states only the first; the row
 * badges the others and the page states them all.
 *
 * Only what the wire states is claimed. A merged or closed pull request has
 * left the open list, so it can no longer say whose it was (`mine` is false
 * there by contract) — its reason is the checkout, and that is all it says.
 */
export function pullRequestReasons(
  item: PullRequestInventoryItem,
): PullRequestReason[] {
  if (item.state !== "open")
    return item.worktreeId
      ? [
          {
            kind: "local-worktree",
            label: `A local worktree still holds ${item.headBranch}`,
            short: "local checkout",
          },
        ]
      : [];
  const reasons: PullRequestReason[] = [];
  if (item.reviewRequested)
    reasons.push({
      kind: "review-requested",
      label: "Your review was requested",
      // What it asks of you, in one word; the solid badge says it is asked.
      short: "review",
    });
  if (item.mine)
    reasons.push({
      kind: "author",
      label: "You opened it",
      short: "mine",
    });
  if (item.assignedToMe)
    reasons.push({
      kind: "assignee",
      label: "You are assigned",
      short: "assigned",
    });
  const teams = item.teamReviewRequests ?? [];
  if (teams.length > 0)
    reasons.push({
      kind: "team-review",
      label: `Review requested from ${teams.length === 1 ? "your team" : "your teams"} ${teams.map((team) => `@${team}`).join(", ")}`,
      // One word on a row, however many teams: the label (its tooltip, and
      // the detail page) names them.
      short: "team",
    });
  return reasons;
}

/**
 * The row's identity: project, provider, repository and number — the SAME four
 * components the route addresses one by (`pullRequestPath`), so a row, its URL
 * and the page it opens cannot name different pull requests.
 *
 * A number alone names nothing — every repository has a #1 — and one project
 * can hold two repositories, since a spawned worktree may publish to a
 * `pushurl` repository its main checkout does not list (`docs/pull-requests.md`).
 * This is also the React key and the `data-list-row-id`, so a restore cannot
 * drift onto another repository's row.
 */
export function pullRequestRowId(item: PullRequestInventoryItem): string {
  return `${item.projectId}#${item.provider}#${item.repositoryKey}#${item.number}`;
}

/** What the route addresses, and what a row hands back when it is opened. */
export function pullRequestTargetOf(
  item: PullRequestInventoryItem,
): PullRequestTarget {
  return {
    projectId: item.projectId,
    provider: item.provider,
    repositoryKey: item.repositoryKey,
    number: item.number,
  };
}

/**
 * Whether this item IS that target. ALL FOUR components, always. Each one rules
 * out a collision the others do not: two projects, two providers (`owner/repo`
 * is only unique within one), two repositories of one project (a `pushurl`
 * fork), and two numbers. Matching on a subset selects, highlights and opens
 * more than one pull request as if it were one.
 *
 * It is exactly `pullRequestRowId(item) === rowIdOf(target)`, written out so
 * the comparison cannot be read as string-formatting luck.
 */
export function isPullRequestTarget(
  item: PullRequestInventoryItem,
  target: PullRequestTarget | null | undefined,
): boolean {
  return (
    target !== null &&
    target !== undefined &&
    item.projectId === target.projectId &&
    item.provider === target.provider &&
    item.repositoryKey === target.repositoryKey &&
    item.number === target.number
  );
}

/**
 * Ordering inside a group: most recently updated first.
 *
 * `updatedAt` is optional on the wire, and an unknown timestamp must not win
 * the top of the list, so it reads as 0 — oldest. The tie-break is the row id,
 * which makes the order TOTAL: `updatedAt` has second granularity on both
 * providers, so ties are ordinary rather than exotic, and a comparator that
 * left them unresolved would let the list reshuffle on a poll that changed
 * nothing.
 */
export function comparePullRequests(
  a: PullRequestInventoryItem,
  b: PullRequestInventoryItem,
): number {
  const updated = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  if (updated !== 0) return updated;
  const left = pullRequestRowId(a);
  const right = pullRequestRowId(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface PullRequestInboxOptions {
  view?: PullRequestListView;
  /** The clock the date bands are cut against. */
  now?: number;
  /** Resolved project labels, for project group headings and their order. */
  projectLabels?: Record<string, string>;
}

/** Whether the view's filters keep this pull request. */
export function matchesPullRequestView(
  item: PullRequestInventoryItem,
  view: PullRequestListView,
): boolean {
  if (view.projectId !== null && item.projectId !== view.projectId)
    return false;
  if (view.hideDrafts && item.draft) return false;
  return view.reasons.includes(classifyPullRequest(item));
}

interface PullRequestGroup {
  /** Stable: a reason id, `project:<id>`, or `all`. */
  id: string;
  title: string;
  description: string;
  /** Has a disclosure heading. */
  collapsible: boolean;
  /**
   * Where a collapsible group starts. The team group starts closed: it is
   * often every pull request of a repository (a CODEOWNERS rule).
   */
  defaultOpen: boolean;
  /** Draws its heading in the attention tone. */
  emphasis: boolean;
  /** Set on a project group: its heading is the project's. */
  projectId?: string;
  items: PullRequestInventoryItem[];
}

export interface PullRequestInboxView {
  /** Only the groups that have rows, in render order. */
  groups: PullRequestGroup[];
  /** Nothing passed the filters — an empty state only once the source answered. */
  empty: boolean;
  /** Rows across every group, for a count. */
  total: number;
}

export function buildPullRequestInbox(
  items: readonly PullRequestInventoryItem[],
  options: PullRequestInboxOptions = {},
): PullRequestInboxView {
  const view = options.view ?? DEFAULT_PULL_REQUEST_VIEW;
  const shown = items.filter((item) => matchesPullRequestView(item, view));
  const groups: PullRequestGroup[] = [];
  if (view.groupBy === "reason") {
    for (const meta of PULL_REQUEST_GROUPS) {
      const rows = shown.filter(
        (item) => classifyPullRequest(item) === meta.id,
      );
      if (rows.length === 0) continue;
      groups.push({
        ...meta,
        collapsible: true,
        defaultOpen: meta.id !== "team-review",
        emphasis: meta.id === "needs-review",
        items: rows.sort(comparePullRequests),
      });
    }
  } else if (view.groupBy === "project") {
    const byProject = new Map<string, PullRequestInventoryItem[]>();
    for (const item of shown) {
      const rows = byProject.get(item.projectId) ?? [];
      rows.push(item);
      byProject.set(item.projectId, rows);
    }
    const label = (id: string) => options.projectLabels?.[id] ?? id;
    for (const [projectId, rows] of [...byProject].sort(([a], [b]) =>
      label(a).localeCompare(label(b)),
    ))
      groups.push({
        id: `project:${projectId}`,
        title: label(projectId),
        description: `Pull requests in ${label(projectId)}`,
        collapsible: true,
        defaultOpen: true,
        emphasis: false,
        projectId,
        items: rows.sort(comparePullRequests),
      });
  } else {
    const now = options.now ?? Date.now();
    const byBand = new Map<DateBand, PullRequestInventoryItem[]>();
    for (const item of shown) {
      const band = dateBandOf(item.updatedAt, now);
      const rows = byBand.get(band) ?? [];
      rows.push(item);
      byBand.set(band, rows);
    }
    for (const band of DATE_BANDS) {
      const rows = byBand.get(band.id);
      if (!rows?.length) continue;
      groups.push({
        id: `date:${band.id}`,
        title: band.title,
        description: `Updated ${band.title.toLowerCase()}`,
        collapsible: true,
        defaultOpen: true,
        emphasis: false,
        items: rows.sort(comparePullRequests),
      });
    }
  }
  return { groups, empty: shown.length === 0, total: shown.length };
}

/* -------------------------------- vocabulary ------------------------------- */

/**
 * CI as a row states it. `unknown` is a real value: the provider was not
 * reached, or this is a terminal pull request whose checks are no longer the
 * question. `none` is the opposite — an answer that this head has no checks at
 * all — and the two must never render alike.
 */
export type PullRequestCiTone =
  "success" | "failure" | "pending" | "error" | "none" | "unknown";

export interface PullRequestGlyphState<T extends string> {
  tone: T;
  /** The words, which are also the accessible name behind the glyph. */
  label: string;
}

export function pullRequestCiState(
  item: PullRequestInventoryItem,
): PullRequestGlyphState<PullRequestCiTone> {
  if (!item.ci)
    return item.state === "open"
      ? { tone: "unknown", label: "CI unknown" }
      : { tone: "none", label: "No checks" };
  const total = item.ci.total;
  const suffix =
    total > 0 ? ` (${total} ${total === 1 ? "check" : "checks"})` : "";
  switch (item.ci.state) {
    case "success":
      return { tone: "success", label: `CI passed${suffix}` };
    case "failure":
      return { tone: "failure", label: `CI failed${suffix}` };
    case "pending":
      return { tone: "pending", label: `CI running${suffix}` };
    case "error":
      return { tone: "error", label: `CI errored${suffix}` };
  }
}

/**
 * Review as a row states it. `unresolved` is only reachable when the provider
 * actually counted threads: `unresolvedThreads` is optional precisely because
 * REST cannot always tell, and reporting 0 there would read as "all resolved".
 */
export type PullRequestReviewTone =
  "changes-requested" | "unresolved" | "clear" | "requested" | "unknown";

export function pullRequestReviewState(
  item: PullRequestInventoryItem,
): PullRequestGlyphState<PullRequestReviewTone> {
  if (item.state !== "open") return { tone: "unknown", label: "Review closed" };
  if (!item.review)
    return item.reviewRequested
      ? { tone: "requested", label: "Your review was requested" }
      : { tone: "unknown", label: "Review unknown" };
  if (item.review.changesRequested)
    return { tone: "changes-requested", label: "Changes requested" };
  const threads = item.review.unresolvedThreads;
  if (threads !== undefined && threads > 0)
    return {
      tone: "unresolved",
      label: `${threads} unresolved ${threads === 1 ? "thread" : "threads"}`,
    };
  if (item.reviewRequested)
    return { tone: "requested", label: "Your review was requested" };
  return { tone: "clear", label: "No review objections" };
}

/**
 * Mergeability, three-valued plus "not applicable".
 *
 * `mergeable: null` is the provider saying it has not finished computing —
 * GitHub answers it literally right after a push, and the Forgejo seam maps a
 * draft's `false` onto it — so it means ASK AGAIN and may never be rendered as
 * a conflict. Absent means the field was not read at all.
 */
export type PullRequestMergeabilityTone =
  "mergeable" | "conflicts" | "checking" | "unknown" | "not-applicable";

export function pullRequestMergeability(
  item: PullRequestInventoryItem,
): PullRequestGlyphState<PullRequestMergeabilityTone> {
  if (item.state === "merged")
    return { tone: "not-applicable", label: "Merged" };
  if (item.state === "closed")
    return { tone: "not-applicable", label: "Closed without merging" };
  if (item.mergeable === undefined)
    return { tone: "unknown", label: "Mergeability unknown" };
  if (item.mergeable === null)
    return { tone: "checking", label: "The provider is still checking" };
  return item.mergeable
    ? { tone: "mergeable", label: "No conflicts with the base branch" }
    : { tone: "conflicts", label: "Conflicts with the base branch" };
}

/**
 * Why this pull request cannot be merged from here, or `undefined` when it can
 * be offered. The reason is TEXT, because it is rendered as text under the
 * control it disables: a tooltip on a disabled button reaches neither a
 * keyboard nor a phone.
 *
 * Only answers that are KNOWN block. `mergeable: null` is the provider still
 * checking and `undefined` is not read at all — neither is a conflict, and the
 * provider remains the authority on whether a merge is allowed, so nothing else
 * is pre-judged here. Unknown capabilities are the one place absence blocks,
 * and in the fail-closed direction: no method may be offered when the set that
 * would be offered from could not be read.
 */
export function pullRequestMergeBlockedReason(
  item: PullRequestInventoryItem,
): string | undefined {
  if (item.state !== "open") return undefined;
  if (item.draft)
    return `#${item.number} is a draft. Mark it ready for review before merging.`;
  if (item.mergeable === false)
    return `#${item.number} conflicts with ${item.baseBranch}. Merging is not offered until the branch is updated.`;
  const methods = item.capabilities?.mergeMethods;
  if (!methods)
    return `The merge methods this repository allows could not be read${
      item.capabilities?.unknownReason
        ? ` (${item.capabilities.unknownReason})`
        : ""
    }, so no merge is offered.`;
  if (methods.length === 0)
    return "This repository allows no merge method for pull requests.";
  return undefined;
}

/** The state pill: open/draft/merged/closed, in the row's own words. */
export type PullRequestStateTone = "open" | "draft" | "merged" | "closed";

export function pullRequestStateLabel(
  item: PullRequestInventoryItem,
): PullRequestGlyphState<PullRequestStateTone> {
  if (item.state === "merged") return { tone: "merged", label: "Merged" };
  if (item.state === "closed") return { tone: "closed", label: "Closed" };
  return item.draft
    ? { tone: "draft", label: "Draft" }
    : { tone: "open", label: "Open" };
}

/** The hosting provider as a product name, for "Open on GitHub". */
export function hostingProviderLabel(provider: GitHostingProviderKind): string {
  return provider === "github" ? "GitHub" : "Forgejo";
}

/* ------------------------------ the detail read ----------------------------- */

/**
 * What the route addresses — the SAME four components the server's join key is
 * made of (`pullRequestIdentity.ts`), because a client that addresses on fewer
 * addresses more than one pull request.
 */
export interface PullRequestTarget {
  projectId: string;
  provider: GitHostingProviderKind;
  /** `owner/repo`, lowercased — `PullRequestInventoryItem.repositoryKey`. */
  repositoryKey: string;
  number: number;
}

/**
 * The detail page's own state, derived from the ONE inventory the app polls
 * (`hooks/usePullRequestInventory.ts`) — the detail route never fetches for
 * itself.
 *
 * This is where the loading model is decided rather than remembered
 * (`app/web/docs/loading-states.md`):
 *
 *  - no target → `idle`, there is nothing to show;
 *  - the inventory has not answered → `loading`, NEVER "no such pull request".
 *    That is R1: an unanswered source may not claim a thing is missing;
 *  - the inventory answered and does not hold it → `ready(null)`, which the
 *    page renders as the authoritative "gone" state;
 *  - a poll for the same inventory is running → `refreshing` with the item, so
 *    the page never blanks (R2);
 *  - a failed poll keeps the last item and carries the error beside it.
 *
 * R3 — a different pull request gets a placeholder — falls out of the target
 * being part of this derivation AND of the page being keyed by it: what cannot
 * happen is the previous pull request's body under the new number.
 */
export function pullRequestDetailState(
  inventory: LoadState<PullRequestInventoryItem[]>,
  target: PullRequestTarget | null,
): LoadState<PullRequestInventoryItem | null> {
  if (!target) return idle();
  const items = dataOf(inventory);
  if (items === undefined)
    return inventory.status === "error" ? failed(inventory.error) : loading();
  const found = items.find((item) => isPullRequestTarget(item, target)) ?? null;
  if (inventory.status === "error") return failed(inventory.error, found);
  return inventory.status === "refreshing" ? refreshing(found) : ready(found);
}

/* --------------------------- the local join sources ------------------------- */

/**
 * One list a join id is resolved against, with what is known about its
 * CURRENCY. The ids come from the inventory and are authoritative; these lists
 * are not, and the difference is what the detail page has to render.
 */
export interface JoinSource<T> {
  /** `null` until this list has ever answered. */
  rows: readonly T[] | null;
  /**
   * An authoritative answer arrived for the CURRENT connection episode. Only a
   * fresh list may be quoted as evidence that an id is not in it.
   */
  fresh: boolean;
  /** The last refresh of it FAILED; `rows` is what was retained. */
  error?: string | undefined;
}

/** What one join id resolves to, which is three answers rather than two. */
export type JoinRowState<T> =
  /** Found. Rendered even from a stale list — retained data stays readable. */
  | { kind: "resolved"; id: string; row: T }
  /**
   * Not found, and the list cannot be quoted against it: it has never
   * answered, or its current answer is stale or failed. The row is RESERVED,
   * because a newly linked object is exactly what a list that has not caught
   * up is missing.
   */
  | { kind: "pending"; id: string }
  /**
   * Not found in a FRESH list. That is real: an archived session or Task is
   * not in these lists and never will be, so nothing is coming for this row
   * and a placeholder would spin forever.
   */
  | { kind: "absent"; id: string };

/**
 * Resolve join ids against their list.
 *
 * The rule the whole thing turns on: MISSING IS NOT ABSENT unless the list is
 * fresh. Treating any gap as absence makes a refresh — or a reconnect, or one
 * failed read — announce that a pull request has no Task, at the moment the
 * Task was just linked to it.
 */
export function resolveJoinRows<T>(
  ids: readonly string[],
  source: JoinSource<T>,
  identify: (row: T) => string,
): JoinRowState<T>[] {
  const byId = new Map((source.rows ?? []).map((row) => [identify(row), row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (row !== undefined) return { kind: "resolved", id, row };
    return source.rows !== null && source.fresh
      ? { kind: "absent", id }
      : { kind: "pending", id };
  });
}

/** The three lists the inventory's join ids are resolved against. */
export interface PullRequestJoinSources {
  worktrees: JoinSource<WorktreeRecord>;
  sessions: JoinSource<SessionListItem>;
  tasks: JoinSource<TaskSummary>;
}

/**
 * The slice of app state those sources are read from — structurally a subset of
 * `UIState`, so the caller passes its state straight in.
 */
export interface PullRequestJoinState {
  worktrees: WorktreeRecord[] | null;
  worktreesFresh: boolean;
  worktreeListError: string | null;
  taskList: { items: TaskSummary[] } | null;
  taskListFresh: boolean;
  taskListError: string | null;
  sessions: SessionListItem[];
  sessionListFresh: boolean;
}

/**
 * Map app state onto the join sources, in ONE place.
 *
 * It is a function rather than three prop expressions because the failure it
 * prevents is a one-character edit: an `?? []` or a dropped `fresh` reads as
 * tidying up and silently turns "we do not know yet" into "there are none".
 *
 * Every source states its own CURRENT-EPISODE freshness, `sessionListFresh`
 * included. That flag exists because the derivation that looks like it would
 * do — `connected && hydrationSource === "live"` — is wrong in the one window
 * that matters: `hydrationSource` is historical and survives a disconnect, and
 * the status reducer turns `connected` back on immediately for a
 * previously-live shell, BEFORE the new episode's `ready` replaces the session
 * list. A session linked in the meantime would then be reported as
 * authoritatively absent from rows belonging to the previous episode.
 *
 * Archived sessions are loaded on demand and legitimately absent even from a
 * fresh list, which is precisely what the `absent` answer is for.
 */
export function pullRequestJoinSources(
  state: PullRequestJoinState,
): PullRequestJoinSources {
  return {
    worktrees: {
      rows: state.worktrees,
      fresh: state.worktreesFresh,
      ...(state.worktreeListError ? { error: state.worktreeListError } : {}),
    },
    sessions: { rows: state.sessions, fresh: state.sessionListFresh },
    tasks: {
      rows: state.taskList?.items ?? null,
      fresh: state.taskListFresh,
      ...(state.taskListError ? { error: state.taskListError } : {}),
    },
  };
}

/**
 * The sessions a pull request is joined to: the inventory's ids plus every
 * session the LIVE list places in its checkout. The inventory is a snapshot the
 * server rebuilds on its provider cadence, so a session started in the checkout
 * a moment ago is not in it yet; the session rows carry `worktreeId` and arrive
 * by subscription, so that half of the join is made here, where it is current.
 */
export function pullRequestSessionIds(
  item: { worktreeId?: string | undefined; sessionIds: string[] },
  sessions: readonly SessionListItem[] | null,
): string[] {
  const { worktreeId } = item;
  if (!worktreeId || !sessions) return item.sessionIds;
  const ids = new Set(item.sessionIds);
  for (const session of sessions)
    if (session.worktreeId === worktreeId) ids.add(session.id);
  return ids.size === item.sessionIds.length ? item.sessionIds : [...ids];
}

/** One row of a pull request's session tree. */
export interface PullRequestSessionTreeRow {
  session: SessionListItem;
  /** 1 = a tree's root, as `SessionInboxCard.depth` counts. */
  depth: number;
  /** The pull request names this session itself (its join ids). */
  linked: boolean;
}

/**
 * The sessions a pull request is joined to, each shown in its WHOLE spawn
 * tree: from the session at the top of its `spawnedBySessionId` chain down
 * through every peer at every depth, so the coordinator that started the work
 * and the peers beside the linked one are visible too. Trees are ordered by
 * their latest activity, siblings likewise, newest first. Archived sessions
 * are out, as everywhere a session list is shown; a spawn cycle is walked
 * once. Only sessions the list HOLDS can appear — the join ids that resolve
 * nothing are the caller's to state.
 */
export function pullRequestSessionTree(
  sessions: readonly SessionListItem[],
  linkedIds: readonly string[],
): PullRequestSessionTreeRow[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, SessionListItem[]>();
  for (const session of sessions) {
    const parent = session.spawnedBySessionId;
    if (session.archived || !parent || parent === session.id) continue;
    const list = children.get(parent) ?? [];
    list.push(session);
    children.set(parent, list);
  }
  const linked = new Set(linkedIds);
  const rootOf = (session: SessionListItem): SessionListItem => {
    const seen = new Set<string>([session.id]);
    let current = session;
    for (;;) {
      const parent = current.spawnedBySessionId
        ? byId.get(current.spawnedBySessionId)
        : undefined;
      if (!parent || parent.archived || seen.has(parent.id)) return current;
      seen.add(parent.id);
      current = parent;
    }
  };
  // The latest activity anywhere in a subtree, so a tree whose peer just
  // moved sorts above one that went quiet.
  const latest = new Map<string, number>();
  const latestOf = (session: SessionListItem, seen: Set<string>): number => {
    const known = latest.get(session.id);
    if (known !== undefined) return known;
    seen.add(session.id);
    let value = session.updatedAt;
    for (const child of children.get(session.id) ?? [])
      if (!seen.has(child.id)) value = Math.max(value, latestOf(child, seen));
    latest.set(session.id, value);
    return value;
  };
  const roots = new Map<string, SessionListItem>();
  for (const id of linkedIds) {
    const session = byId.get(id);
    if (!session || session.archived) continue;
    const root = rootOf(session);
    roots.set(root.id, root);
  }
  const byActivity = (a: SessionListItem, b: SessionListItem) =>
    latestOf(b, new Set()) - latestOf(a, new Set());
  const rows: PullRequestSessionTreeRow[] = [];
  const walked = new Set<string>();
  const walk = (session: SessionListItem, depth: number) => {
    if (walked.has(session.id)) return;
    walked.add(session.id);
    rows.push({ session, depth, linked: linked.has(session.id) });
    for (const child of [...(children.get(session.id) ?? [])].sort(byActivity))
      walk(child, depth + 1);
  };
  for (const root of [...roots.values()].sort(byActivity)) walk(root, 1);
  return rows;
}
