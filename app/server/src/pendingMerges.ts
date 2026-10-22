/**
 * Merges a provider ACCEPTED but has not confirmed, by pull-request identity
 * (`pullRequestIdentity.ts`), and the one judgement of where such a request
 * stands.
 *
 * Every merge surface reaches the same record: the merge seam writes it next
 * to the cards' durable `pendingMerge` (same object), the watcher settles it,
 * and the Pull Requests view's state check — which often has no card at all,
 * and whose browser may have lost the pending answer — finds it here. The
 * registry is memory only; the cards' copy is what survives a restart, and
 * the watcher (which polls every open card on boot) puts it back.
 */
import type { PullRequestDetail } from "@assistant/shared";
import type { MergeRequestStatus } from "./gitHosting.ts";
import type { PendingPullRequestMerge } from "./pullRequestCards.ts";

const outstanding = new Map<string, PendingPullRequestMerge>();

export function recordPendingMerge(
  key: string,
  record: PendingPullRequestMerge,
): void {
  outstanding.set(key, record);
}

export function pendingMergeFor(
  key: string,
): PendingPullRequestMerge | undefined {
  return outstanding.get(key);
}

/**
 * Rewrite the record, but only while it is still THIS attempt's (or there is
 * none): a newer attempt recorded meanwhile is never overwritten by an older
 * one's bookkeeping.
 */
export function updatePendingMerge(
  key: string,
  record: PendingPullRequestMerge,
): void {
  const current = outstanding.get(key);
  if (!current || current.requestedAt === record.requestedAt)
    outstanding.set(key, record);
}

/** Drop the record, but only while it is still THIS attempt's. */
export function forgetPendingMerge(
  key: string,
  record?: PendingPullRequestMerge,
): void {
  if (!record || outstanding.get(key)?.requestedAt === record.requestedAt)
    outstanding.delete(key);
}

/** Test seam. */
export function resetPendingMergesForTests(): void {
  outstanding.clear();
}

/**
 * How long an attempt nobody can follow — the provider named no request, so
 * only the pull request itself can answer — is watched before its outcome is
 * stated as unknown. A direct merge settles in seconds; ten minutes is the
 * bound past which waiting longer tells nobody anything.
 */
const NO_REQUEST_WATCH_MS = 10 * 60_000;
/**
 * How long a request whose status cannot be READ is kept. A fresh answer
 * always wins over this: GitHub's own expiry (24 h after the request's LAST
 * update) arrives as `expired`, never inferred from the clock.
 */
const UNREADABLE_REQUEST_MS = 24 * 60 * 60_000;

export type PendingMergeVerdict =
  /** Not settled: the request runs, or there is still reason to watch. */
  | { kind: "pending" }
  /** Settled without a failure to report: the pull request speaks. */
  | { kind: "settled"; why: "terminal" | "expired" }
  /** It did not merge, and this is why. */
  | { kind: "failed"; message: string }
  /** Following it ended without an answer: whether it merged is unknown. */
  | { kind: "unknown"; reason: string };

/**
 * The record after one attempt to read its request's status: a fresh answer
 * clears `unreadableSince`, a failed read starts it (once). `answer` is
 * `undefined` for a read that failed or could not be made.
 */
export function noteStatusRead(
  record: PendingPullRequestMerge,
  answer: MergeRequestStatus | undefined,
  now: number,
): PendingPullRequestMerge {
  if (!record.requestId) return record;
  if (answer) {
    if (record.unreadableSince === undefined) return record;
    const next = { ...record };
    delete next.unreadableSince;
    return next;
  }
  return record.unreadableSince === undefined
    ? { ...record, unreadableSince: now }
    : record;
}

/** The record kept as an `unknown` answer once following it ended. */
export function asUnknown(
  record: PendingPullRequestMerge,
  reason: string,
  message: string = record.message,
): PendingPullRequestMerge {
  return { ...record, unknownReason: reason, message };
}

/**
 * Where an accepted merge stands, from the pull request's current detail and
 * — when there is a request to ask — the provider's FRESH answer about it,
 * which always wins: `failed` is a failure and `pending` keeps it, however old.
 * Only without one (no request id, or a read that failed) does anything else
 * decide: a head that moved past the conditioned one cannot be merged by that
 * request, a record already known to be `unknown` stays so, and a bounded
 * watch — ten minutes without a request id, a day of UNREADABLE status —
 * ends in an explicit "unknown", never in "did not merge". `record` must
 * already carry `noteStatusRead`'s bookkeeping.
 */
export function judgePendingMerge(
  record: PendingPullRequestMerge,
  detail: PullRequestDetail,
  answer: MergeRequestStatus | undefined,
  now: number,
): PendingMergeVerdict {
  if (detail.merged || detail.state !== "open")
    return { kind: "settled", why: "terminal" };
  if (answer) {
    if (answer.status === "failed")
      return {
        kind: "failed",
        message: answer.message ?? "the merge request failed",
      };
    if (answer.status === "expired") return { kind: "settled", why: "expired" };
    // `pending`, or `merged` while the detail has not caught up yet.
    return { kind: "pending" };
  }
  if (
    record.expectedHeadSha &&
    detail.headSha.toLowerCase() !== record.expectedHeadSha.toLowerCase()
  )
    return {
      kind: "failed",
      message: `the branch moved past ${record.expectedHeadSha.slice(0, 12)}, the head that merge was conditioned on, so it cannot land`,
    };
  if (record.unknownReason)
    return { kind: "unknown", reason: record.unknownReason };
  const since = record.requestId ? record.unreadableSince : record.requestedAt;
  const watch = record.requestId ? UNREADABLE_REQUEST_MS : NO_REQUEST_WATCH_MS;
  if (since !== undefined && now - since > watch)
    return {
      kind: "unknown",
      reason: record.requestId
        ? "its status could not be read for a day"
        : "the provider named no request to follow, and the pull request is still open",
    };
  return { kind: "pending" };
}
