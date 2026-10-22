import {
  agentHandoffOwed,
  agentHandoffUnavailable,
  drainAgentHandoffs,
} from "./agentHandoffs.ts";
import type { BackgroundCompletionDelivery } from "./backgroundWork/completionDelivery.ts";
import type {
  DeliveryLane,
  DeliveryResult,
  DeliveryAcquisitionFailure,
} from "./deliveryScheduler.ts";
import {
  drainRecipient,
  offerReplyReminders,
  peerFifoOwed,
  peerNoticeOwed,
  noteDrainTargetUnavailable,
  replyReminderOwed,
} from "./peerPrompt.ts";
import {
  drainPromptQueue,
  promptQueueHasPriority,
  promptQueueUnavailable,
  type PromptQueueDriver,
} from "./promptQueue.ts";
import { subscribeSessionUserEntry } from "./session/runtime/liveSession.ts";
import { hasExplicitRecipientAuthority } from "./recipientDrainAuthority.ts";
import { workflowAssignmentDelivery } from "./workflow/assignmentDelivery.ts";

/**
 * Today's drains own their run promises and private locks. Observe the append
 * to return admission immediately, and fence their later claims. This is not a
 * per-prompt subscription: lanes interpret their own runtime receipts.
 */
function createDeliver() {
  const settling = new Map<string, Set<Promise<DeliveryResult>>>();

  return async function deliver(
    session: PromptQueueDriver,
    drain: (shouldStart: () => boolean) => Promise<void>,
  ): Promise<DeliveryResult> {
    const id = session.sessionId;
    // The idle hook fires before the provider prompt and its drain settle.
    // Joining that drain would reuse its fenced admission and swallow this
    // offer. Wait before observing appends or entering ANY sibling drain:
    // background's peer phase also holds the peer lock. Running offers must
    // not wait for the turn they are allowed to steer.
    if (!session.isRunning) {
      const earlier = [...(settling.get(id) ?? [])];
      if (earlier.length > 0) {
        // Diagnostic only: a timeout must not admit over a still-owned drain.
        const warning = setTimeout(() => {
          console.warn(
            `[delivery] session ${id} is idle but ${earlier.length} earlier drain(s) have not settled after 30s`,
          );
        }, 30_000);
        warning.unref?.();
        try {
          await Promise.all(earlier.map((run) => run.catch(() => {})));
        } finally {
          clearTimeout(warning);
        }
      }
    }
    let appended = false;
    const running = session.isRunning;
    let onAppend!: (result: DeliveryResult) => void;
    const admitted = new Promise<DeliveryResult>((resolve) => {
      onAppend = resolve;
    });
    const unsubscribe = subscribeSessionUserEntry((sessionId) => {
      if (sessionId !== id) return;
      appended = true;
      unsubscribe();
      onAppend(running ? "steer" : "turn");
    });
    const pending = settling.get(id) ?? new Set<Promise<DeliveryResult>>();
    settling.set(id, pending);
    const drained = Promise.resolve()
      .then(() => drain(() => !appended))
      .then<DeliveryResult>(() => "none")
      .finally(() => {
        unsubscribe();
        pending.delete(drained);
        if (pending.size === 0) settling.delete(id);
      });
    pending.add(drained);
    return Promise.race([admitted, drained]);
  };
}

export function sessionDeliveryLanes(
  background: BackgroundCompletionDelivery,
): {
  lanes: DeliveryLane<PromptQueueDriver>[];
  reminder: DeliveryLane<PromptQueueDriver>;
} {
  const deliver = createDeliver();
  return {
    lanes: [
      {
        name: "handoffs",
        mayJoinRunningTurn: false,
        owes: agentHandoffOwed,
        unavailable: agentHandoffUnavailable,
        deliver: (session) =>
          deliver(session, (shouldStart) =>
            drainAgentHandoffs(session.sessionId, {
              driver: session,
              shouldStart,
            }),
          ),
      },
      {
        name: "user queue",
        mayJoinRunningTurn: false,
        owes: promptQueueHasPriority,
        unavailable: promptQueueUnavailable,
        deliver: (session) =>
          deliver(session, (shouldStart) =>
            drainPromptQueue(session.sessionId, shouldStart, session),
          ),
      },
      {
        name: "workflow assignments",
        mayJoinRunningTurn: false,
        owes: workflowAssignmentDelivery.owes,
        unavailable: workflowAssignmentDelivery.unavailable,
        deliver: (session) =>
          deliver(session, (shouldStart) =>
            workflowAssignmentDelivery.deliver(session, shouldStart),
          ),
      },
      ...(["fifo", "notices"] as const).map((phase) => ({
        name: `peer ${phase}`,
        mayJoinRunningTurn: false,
        owes: phase === "fifo" ? peerFifoOwed : peerNoticeOwed,
        unavailable: (id: string, failure: DeliveryAcquisitionFailure) =>
          noteDrainTargetUnavailable(id, failure.reason, phase),
        deliver: (session: PromptQueueDriver) =>
          deliver(session, (shouldStart) =>
            drainRecipient(session.sessionId, {
              phase,
              driver: session,
              shouldStart,
            }),
          ),
      })),
      {
        name: "background completions",
        mayJoinRunningTurn: true,
        owes: (id) => background.wakeOwed(id),
        unavailable: async (id, failure) => {
          // A thrown offer kept the pending facts; an unavailable driver gave
          // up only the in-memory batch, leaving durable outbox debt intact.
          if (
            failure.kind === "unavailable" &&
            !hasExplicitRecipientAuthority(id)
          )
            await background.unavailable(id);
        },
        deliver: (session) =>
          deliver(session, (shouldStart) =>
            background.drain(session.sessionId, shouldStart),
          ),
      },
    ],
    reminder: {
      name: "reminders",
      mayJoinRunningTurn: false,
      owes: replyReminderOwed,
      deliver: (session) =>
        deliver(session, (shouldStart) =>
          offerReplyReminders(session.sessionId, {
            driver: session,
            shouldStart,
          }),
        ),
    },
  };
}
