/**
 * How many background-work updates are waiting to reach each session, as that
 * session's viewers see it beside its peer queue. The count is the delivery
 * queue's own (`BackgroundCompletionDelivery.queuedCount`), so it is exactly
 * the work that will reach the model and costs a map lookup; it is installed
 * at boot because the delivery queue is built there, and harness state
 * builders read it through {@link backgroundUpdateQueueField}.
 *
 * A change reaches the session's viewers once per microtask, however many
 * notices one drain moved.
 */
import type { BackgroundHandlingRef } from "@assistant/shared";

interface BackgroundUpdateQueueSource {
  count(sessionId: string): number;
  /** Delivered into a turn that did not finish (`backgroundCompletionNotices.ts`). */
  unhandled(sessionId: string): {
    count: number;
    batch: BackgroundHandlingRef[];
  };
  publish(
    sessionId: string,
    count: number,
    unhandled: { count: number; batch: BackgroundHandlingRef[] },
  ): void;
}

let source: BackgroundUpdateQueueSource | undefined;
const due = new Set<string>();

export function installBackgroundUpdateQueue(
  next: BackgroundUpdateQueueSource | undefined,
): void {
  source = next;
  due.clear();
}

/** The session state's fields; each absent when nothing is there. */
export function backgroundUpdateQueueField(sessionId: string): {
  queuedBackgroundUpdates?: number;
  unhandledBackgroundUpdates?: number;
  unhandledBackgroundBatch?: BackgroundHandlingRef[];
} {
  const count = source?.count(sessionId) ?? 0;
  const unhandled = source?.unhandled(sessionId) ?? { count: 0, batch: [] };
  return {
    ...(count > 0 ? { queuedBackgroundUpdates: count } : {}),
    ...(unhandled.count > 0
      ? {
          unhandledBackgroundUpdates: unhandled.count,
          unhandledBackgroundBatch: unhandled.batch,
        }
      : {}),
  };
}

/** The delivery queue for this session changed; its viewers hear the new count. */
export function backgroundUpdateQueueChanged(sessionId: string): void {
  if (!source || due.has(sessionId)) return;
  due.add(sessionId);
  queueMicrotask(() => {
    if (!due.delete(sessionId) || !source) return;
    try {
      source.publish(
        sessionId,
        source.count(sessionId),
        source.unhandled(sessionId),
      );
    } catch {
      /* best-effort: the next state frame carries the same count */
    }
  });
}
