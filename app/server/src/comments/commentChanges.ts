import type { CommentTarget } from "@assistant/shared";

let notify: (
  target: CommentTarget,
  threadIds: readonly string[],
) => void | Promise<void> = () => undefined;
let notifyMetadata: (
  target: CommentTarget,
  reviewSetIds: readonly string[],
) => void | Promise<void> = () => undefined;

export function setCommentChangeNotifier(next: typeof notify): void {
  notify = next;
}

export function setCommentMetadataChangeNotifier(
  next: typeof notifyMetadata,
): void {
  notifyMetadata = next;
}

/** Domain writes report touched thread ids without knowing the transport. */
export function reportCommentChanges(
  target: CommentTarget,
  threadIds: readonly string[],
): void {
  void Promise.resolve(notify(target, threadIds)).catch(logBroadcastFailure);
}

/** Notify that object-level comment metadata changed without touching a thread. */
export function reportCommentMetadataChanges(
  target: CommentTarget,
  reviewSetIds: readonly string[],
): void {
  void Promise.resolve(notifyMetadata(target, reviewSetIds)).catch(
    logBroadcastFailure,
  );
}

function logBroadcastFailure(error: unknown): void {
  console.warn(
    "[comments] event broadcast failed:",
    error instanceof Error ? error.message : String(error),
  );
}
