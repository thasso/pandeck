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
 * The three groups, in the order they are rendered.
 *
 * `needs-review` leads because somebody else is blocked on it; `cleanup` trails
 * because the work is over and only a checkout is left. The ids are stable —
 * they key the sections' headings and the tests below.
 */
export type PullRequestGroupId = "needs-review" | "yours" | "cleanup";

export interface PullRequestGroupMeta {
  id: PullRequestGroupId;
  title: string;
  /** What the group is, for its empty/assistive wording. */
  description: string;
}

export const PULL_REQUEST_GROUPS: readonly PullRequestGroupMeta[] = [
  {
    id: "needs-review",
    title: "Needs your review",
    description: "Your review was requested",
  },
  { id: "yours", title: "Yours", description: "Pull requests you opened" },
  {
    id: "cleanup",
    title: "Needs cleanup",
    description: "Finished upstream, still checked out locally",
  },
];

/**
 * Which group a pull request belongs to.
 *
 * A terminal pull request is ALWAYS cleanup: the server inventories one only
 * while a local worktree still holds its head branch, so its whole reason for
 * being listed is the checkout. Among open ones a review request outranks
 * authorship — your own pull request that someone also asked you to review is
 * still work somebody is waiting on, and it must not hide in "Yours".
 */
export function classifyPullRequest(
  item: PullRequestInventoryItem,
): PullRequestGroupId {
  if (item.state !== "open") return "cleanup";
  return item.reviewRequested ? "needs-review" : "yours";
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
  query?: string;
  /** Resolved project labels, so the query can match what the row DISPLAYS. */
  projectLabels?: Record<string, string>;
}

/**
 * Whether the query matches. It reads everything the row shows plus the two
 * branches, because "which PR was the one off `release-3`?" is exactly the
 * question this box is opened for. `#41` and `41` both match a number.
 *
 * The needle is normalized HERE rather than by the caller: this is exported,
 * and a helper that silently requires pre-lowercased input answers "no match"
 * for `Release-3` — a failure that looks like a search returning nothing.
 */
export function matchesPullRequestQuery(
  item: PullRequestInventoryItem,
  query: string,
  options: PullRequestInboxOptions = {},
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const bare = needle.startsWith("#") ? needle.slice(1) : needle;
  const haystack = [
    item.title,
    item.headBranch,
    item.baseBranch,
    item.author ?? "",
    options.projectLabels?.[item.projectId] ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle) || String(item.number).includes(bare);
}

interface PullRequestGroup extends PullRequestGroupMeta {
  items: PullRequestInventoryItem[];
}

export interface PullRequestInboxView {
  /** Only the groups that have rows, in `PULL_REQUEST_GROUPS` order. */
  groups: PullRequestGroup[];
  /** Nothing matched — which is an empty state only once the source answered. */
  empty: boolean;
  /** Rows across every group, for a count. */
  total: number;
}

export function buildPullRequestInbox(
  items: readonly PullRequestInventoryItem[],
  options: PullRequestInboxOptions = {},
): PullRequestInboxView {
  // `matchesPullRequestQuery` normalizes for itself, so the raw query travels.
  const query = options.query ?? "";
  const byGroup = new Map<PullRequestGroupId, PullRequestInventoryItem[]>(
    PULL_REQUEST_GROUPS.map((group) => [group.id, []]),
  );
  let total = 0;
  for (const item of items) {
    if (!matchesPullRequestQuery(item, query, options)) continue;
    byGroup.get(classifyPullRequest(item))!.push(item);
    total += 1;
  }
  const groups: PullRequestGroup[] = [];
  for (const meta of PULL_REQUEST_GROUPS) {
    const rows = byGroup.get(meta.id)!;
    if (rows.length === 0) continue;
    rows.sort(comparePullRequests);
    groups.push({ ...meta, items: rows });
  }
  return { groups, empty: total === 0, total };
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
