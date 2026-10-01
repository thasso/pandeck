/**
 * The domain-neutral view of one review comment thread, plus the pure list math
 * over it. Knowledge entries and worktree diffs anchor comments to completely
 * different things (a body line range vs a `path:line` in a commit) but the
 * REVIEW work is identical — triage what is open, dispatch some of it to an
 * agent, keep the rest as history — so the list that does that work speaks this
 * shape and neither domain's types.
 */

type ReviewThreadState = "open" | "resolved";

export interface ReviewThreadView {
  id: string;
  state: ReviewThreadState;
  /** True when re-anchoring lost the passage: unreachable from the document. */
  orphaned: boolean;
  /** True when the passage moved but is still located. */
  moved: boolean;
  /** The thread's opening comment, collapsed to one line for the row. */
  firstLine: string;
  /** Where it sits, in the domain's words: "line 12", "src/app.ts:88". */
  anchorLabel: string;
  /** Who opened it. */
  author: string;
  replies: number;
  /** Already handed to at least one session. `false` is what "new" means. */
  sent: boolean;
  /** Scroll the document to this thread's passage, when it still has one. */
  locate?: () => void;
}

export interface ReviewThreadGroups {
  /** Open and still reachable in the document — the working set. */
  open: ReviewThreadView[];
  /** Open but the passage is gone: only reachable from this list. */
  orphaned: ReviewThreadView[];
  /** Done. Kept for history, never in the way. */
  resolved: ReviewThreadView[];
}

/**
 * Split threads into the three groups a review list shows. Orphaned threads are
 * separated from the ordinary open ones because they are the only threads with
 * no place in the document — the list is the only surface that can show them.
 */
export function groupReviewThreads(
  threads: ReviewThreadView[],
): ReviewThreadGroups {
  const groups: ReviewThreadGroups = { open: [], orphaned: [], resolved: [] };
  for (const thread of threads) {
    if (thread.state === "resolved") groups.resolved.push(thread);
    else if (thread.orphaned) groups.orphaned.push(thread);
    else groups.open.push(thread);
  }
  return groups;
}

/** Every thread a bulk action may act on: the open ones, located or not. */
export function dispatchableThreads(
  groups: ReviewThreadGroups,
): ReviewThreadView[] {
  return [...groups.open, ...groups.orphaned];
}

/**
 * The REVIEW IN PROGRESS: open threads no session has ever been handed. This is
 * the batch "Submit review" sends, and it needs no stored draft state — a comment
 * nobody has been told about is pending by definition. Sending the same comment
 * twice is the mistake it exists to prevent.
 */
export function pendingReviewThreadIds(threads: ReviewThreadView[]): string[] {
  return threads
    .filter((thread) => thread.state === "open" && !thread.sent)
    .map((thread) => thread.id);
}

/** First non-empty line of a comment body, bounded for a one-line row. */
export function firstLineOf(
  body: string | null | undefined,
  max = 160,
): string {
  const line =
    (body ?? "")
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
