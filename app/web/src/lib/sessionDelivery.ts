/**
 * Where a SESSION's pull request stands, for the one indicator that says so on
 * a session row.
 *
 * The fact comes from the authoritative session ↔ card relationship: the server
 * picks the card that speaks for the session and narrows it to
 * `SessionListItem.pullRequest` (`SessionPullRequestSummary`). Nothing here
 * fetches, joins or guesses — a row states what its own list row carries.
 *
 * The PR rungs are the app-wide ladder (`worktreeHosting.ts`), so a session row,
 * a Task row and a worktree card cannot rank the same pull request differently.
 * What is added around it is what only a CARD knows: the two states before the
 * pull request exists, the drafting failure, and the conflict the card itself
 * makes its primary reason to act.
 */
import type {
  SessionListItem,
  SessionPullRequestSummary,
} from "@assistant/shared";
import { hostingAttention, type HostingAttention } from "./worktreeHosting.ts";

/**
 * What the session's card is asking of you.
 *
 * A TERMINAL card is its status and nothing else: `merged` and `closed` answer
 * before the ladder is consulted at all. That is not a style choice — the card's
 * `ci` is the last thing the watcher saw and it STOPS polling the moment the
 * card leaves `open`, so ranking a frozen red check above the merge left a
 * shipped pull request reading "CI failed" forever, with nothing left that could
 * ever revise it. The Worktrees inbox can afford that rung because its CI is
 * live and self-corrects; a card cannot.
 *
 * For a card that is still moving, strongest first:
 *
 * 1. `choosing-task` — the card is blocked on a question only you can answer.
 * 2. `failed` — drafting or creation raised; there is no pull request.
 * 3. `creating` — in flight.
 * 4. the shared ladder, with `conflicts` between its red checks and its review:
 *    a conflicted branch cannot be merged until someone updates it, which is a
 *    stronger claim on you than a review that is merely open.
 * 5. `draft` — open, but not asking for review yet, so it takes the `open` rung
 *    when nothing above it applies. A review ON a draft still outranks it: a
 *    comment someone actually left is not waiting for the draft flag to clear.
 */
export type SessionDeliveryState =
  | "choosing-task"
  | "failed"
  | "creating"
  | "conflicts"
  | HostingAttention
  | "draft"
  | "closed";

/** Semantic tone; the renderer maps it to the theme's tokens. */
export type SessionDeliveryTone =
  "accent" | "warning" | "danger" | "success" | "muted";

/** Everything a row renders about the session's pull request. */
export interface SessionDelivery {
  state: SessionDeliveryState;
  tone: SessionDeliveryTone;
  /** One or two words — all a chip on a one-line row can carry. */
  label: string;
  /** The sentence the chip cannot fit; also the glyph-only row's whole message. */
  title: string;
}

const TONE: Record<SessionDeliveryState, SessionDeliveryTone> = {
  "choosing-task": "accent",
  failed: "danger",
  creating: "accent",
  "ci-failed": "danger",
  conflicts: "warning",
  "review-requested": "warning",
  merged: "success",
  "ci-pending": "accent",
  draft: "muted",
  open: "muted",
  closed: "muted",
};

/**
 * The chip's words. The PR rungs keep the Worktrees inbox's and the Backlog
 * row's wording (`TaskRowBody`'s `DELIVERY_LABEL`) so one state is not learned
 * twice; `open` is the exception the other surfaces make too — a pull request
 * that asks nothing is worth stating as its NUMBER.
 */
const LABEL: Record<SessionDeliveryState, string> = {
  "choosing-task": "Pick task",
  failed: "PR failed",
  creating: "Opening",
  "ci-failed": "CI failed",
  conflicts: "Conflicts",
  "review-requested": "Review",
  merged: "Merged",
  "ci-pending": "CI",
  draft: "Draft",
  open: "PR",
  closed: "Closed",
};

export function sessionDeliveryState(
  pr: SessionPullRequestSummary,
): SessionDeliveryState {
  switch (pr.status) {
    case "choosing-task":
      return "choosing-task";
    case "failed":
      return "failed";
    case "creating":
      return "creating";
    // Terminal: the card's `ci` and `review` stopped being observed here, so
    // neither may outrank the status. See the type's note above.
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    case "open":
      break;
  }
  const attention = hostingAttention({
    pr: { state: "open" },
    ...(pr.ci ? { ci: pr.ci } : {}),
    ...(pr.review ? { review: pr.review } : {}),
  });
  // Red checks stay the top rung, exactly as the shared ladder ranks them; the
  // conflict is inserted directly under it rather than reordering the ladder.
  if (attention === "ci-failed") return "ci-failed";
  if (pr.conflicts) return "conflicts";
  // `open` closes the ladder, so the fallback is unreachable for an open pull
  // request; a draft simply renames that last rung.
  const state = attention ?? "open";
  return state === "open" && pr.draft ? "draft" : state;
}

/**
 * The full indicator, or `null` when the session has no card at all. A card in
 * ANY state is worth an indicator: the point is finding the session that owns
 * the pull request, and a merged or closed one is still the session that did.
 */
export function sessionDelivery(
  session: Pick<SessionListItem, "pullRequest">,
): SessionDelivery | null {
  const pr = session.pullRequest;
  if (!pr) return null;
  const state = sessionDeliveryState(pr);
  return {
    state,
    tone: TONE[state],
    label:
      state === "open" && pr.number !== undefined
        ? `PR #${pr.number}`
        : LABEL[state],
    title: deliveryTitle(pr, state),
  };
}

function deliveryTitle(
  pr: SessionPullRequestSummary,
  state: SessionDeliveryState,
): string {
  const checks =
    pr.ci?.total && pr.ci.total > 0
      ? `${pr.ci.total} ${pr.ci.total === 1 ? "check" : "checks"}`
      : null;
  const threads =
    (pr.review?.unresolvedThreads ?? 0) > 0
      ? `${pr.review?.unresolvedThreads} unresolved ${
          pr.review?.unresolvedThreads === 1 ? "thread" : "threads"
        }`
      : null;
  const parts: Array<string | null> = [];
  switch (state) {
    case "choosing-task":
      // No pull request yet, and no number to name it by: this card is waiting.
      return "Waiting for you to pick the task this pull request is for";
    case "creating":
      return "The pull request is being opened";
    case "failed":
      return "The pull request could not be opened";
    case "ci-failed":
      parts.push("Checks failed", checks);
      break;
    case "conflicts":
      parts.push("Conflicts with the base branch — the branch needs updating");
      break;
    case "review-requested":
      parts.push(
        pr.review?.changesRequested ? "Changes requested" : "Review pending",
        threads,
      );
      break;
    case "merged":
      parts.push("Merged");
      break;
    case "ci-pending":
      parts.push("Checks are running", checks);
      break;
    case "draft":
      parts.push("A draft pull request is open — not up for review yet");
      break;
    case "open":
      parts.push("A pull request is open");
      break;
    case "closed":
      parts.push("Closed without merging");
      break;
  }
  if (pr.number !== undefined) parts.push(`PR #${pr.number}`);
  return parts.filter(Boolean).join(" · ");
}

/**
 * The indicator's content, for the row and card memo keys
 * (`sessionRows.ts`, `sessionInbox.ts`). Same invisible failure as those: a row
 * that renders a fact its key omits simply stops updating, and CI turning red
 * is exactly the kind of change that arrives while nothing else about the
 * session moves.
 */
export function sessionDeliveryKey(
  session: Pick<SessionListItem, "pullRequest">,
): string {
  const delivery = sessionDelivery(session);
  return delivery
    ? `${delivery.state}:${delivery.label}:${delivery.title}`
    : "";
}
