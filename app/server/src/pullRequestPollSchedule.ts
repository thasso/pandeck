/**
 * The pull-request watcher's next-due schedule, in-memory only — rebuilt by
 * `reconcilePullRequestCardsOnBoot` on restart.
 *
 * It lives apart from `pullRequestWatcher.ts` so that the modules the watcher
 * itself imports (the merge projection) can ask for a poll without an import
 * cycle.
 */
export const nextPullRequestPollAt = new Map<string, number>();

/** Poll this card on the next sweep instead of waiting out its current interval. */
export function scheduleImmediatePoll(cardId: string): void {
  nextPullRequestPollAt.set(cardId, 0);
}
