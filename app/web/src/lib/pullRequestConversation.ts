/**
 * Pure shaping for a pull request's conversation on its detail page (no React,
 * no fetches): the order checks are read in, the counts their summary states,
 * which review threads still want an answer, and the words for a review
 * verdict.
 *
 * The same rule as `pullRequestInbox.ts`: an absent field is UNKNOWN. A thread
 * whose `resolved` was not reported is not resolved — it is listed with the
 * open ones, because hiding it behind "resolved" would hide the one comment
 * that may still need you.
 */
import type {
  PullRequestCheck,
  PullRequestCheckTone,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestTimelineEntry,
} from "@assistant/shared";

/** Failures first, then what is still running, then the settled rest. */
const CHECK_ORDER: Record<PullRequestCheckTone, number> = {
  failure: 0,
  pending: 1,
  success: 2,
  neutral: 3,
  skipped: 4,
};

export function orderChecks(
  items: readonly PullRequestCheck[],
): PullRequestCheck[] {
  return [...items].sort(
    (a, b) =>
      CHECK_ORDER[a.tone] - CHECK_ORDER[b.tone] || a.name.localeCompare(b.name),
  );
}

export type CheckCounts = Record<PullRequestCheckTone, number>;

export function checkCounts(items: readonly PullRequestCheck[]): CheckCounts {
  const counts: CheckCounts = {
    failure: 0,
    pending: 0,
    success: 0,
    neutral: 0,
    skipped: 0,
  };
  for (const item of items) counts[item.tone] += 1;
  return counts;
}

/** "2 failed · 1 running · 12 passed", in reading order; "" when empty. */
export function checkCountsLabel(counts: CheckCounts): string {
  const parts: string[] = [];
  if (counts.failure) parts.push(`${counts.failure} failed`);
  if (counts.pending) parts.push(`${counts.pending} running`);
  if (counts.success) parts.push(`${counts.success} passed`);
  if (counts.neutral) parts.push(`${counts.neutral} neutral`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  return parts.join(" · ");
}

/**
 * Threads that still want an answer, and the settled ones. Only a thread the
 * provider REPORTED as resolved is settled; unknown stays open.
 */
export function splitThreads(threads: readonly PullRequestReviewThread[]): {
  open: PullRequestReviewThread[];
  resolved: PullRequestReviewThread[];
} {
  const open: PullRequestReviewThread[] = [];
  const resolved: PullRequestReviewThread[] = [];
  for (const thread of threads)
    (thread.resolved === true ? resolved : open).push(thread);
  return { open, resolved };
}

export const REVIEW_VERDICT_LABEL: Record<PullRequestReviewVerdict, string> = {
  approved: "approved",
  "changes-requested": "requested changes",
  commented: "reviewed",
  dismissed: "review dismissed",
};

/**
 * The last few lines of a diff hunk — the lines the thread was written on.
 * The server bounds the hunk; this bounds what a card shows of it.
 */
export function hunkTail(hunk: string, lines = 4): string {
  return hunk.split("\n").slice(-lines).join("\n");
}

export type PullRequestReviewStatus =
  | { kind: "changes-requested"; by: string[] }
  | { kind: "approved"; by: string[] }
  | { kind: "unreviewed" };

/**
 * Where review stands, as GitHub decides it: each reviewer's LATEST approval
 * or change request counts, a dismissal withdraws theirs, and a plain comment
 * changes nothing. A change request that stands outranks any approval.
 */
export function reviewStatusOf(
  timeline: readonly PullRequestTimelineEntry[],
): PullRequestReviewStatus {
  const latest = new Map<string, "approved" | "changes-requested">();
  for (const entry of timeline) {
    if (entry.kind !== "review" || !entry.author) continue;
    if (entry.verdict === "dismissed") latest.delete(entry.author);
    else if (
      entry.verdict === "approved" ||
      entry.verdict === "changes-requested"
    )
      latest.set(entry.author, entry.verdict);
  }
  const changes = [...latest].filter(([, v]) => v === "changes-requested");
  if (changes.length > 0)
    return { kind: "changes-requested", by: changes.map(([who]) => who) };
  const approvals = [...latest].filter(([, v]) => v === "approved");
  if (approvals.length > 0)
    return { kind: "approved", by: approvals.map(([who]) => who) };
  return { kind: "unreviewed" };
}
