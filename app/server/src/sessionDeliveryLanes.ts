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
 * Drains own their run promises. Observe append to return admission immediately
 * and fence later claims. Lanes interpret their own per-prompt receipts.
 */
function createDeliver() {
  const settling = new Map<string, Set<Promise<DeliveryResult>>>();

  async function settleEarlierDeliveries(id: string): Promise<void> {
    // Shared across lanes: background's peer phase can still own the peer lock.
    const earlier = [...(settling.get(id) ?? [])];
    if (earlier.length === 0) return;
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

  async function deliver(
    session: PromptQueueDriver,
    drain: (shouldStart: () => boolean) => Promise<void>,
  ): Promise<DeliveryResult> {
    const id = session.sessionId;
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
  }

  return { deliver, settleEarlierDeliveries };
}

export function sessionDeliveryLanes(
  background: BackgroundCompletionDelivery,
): {
  lanes: DeliveryLane<PromptQueueDriver>[];
  reminder: DeliveryLane<PromptQueueDriver>;
  settleEarlierDeliveries(sessionId: string): Promise<void>;
} {
  const { deliver, settleEarlierDeliveries } = createDeliver();
  return {
    settleEarlierDeliveries,
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
