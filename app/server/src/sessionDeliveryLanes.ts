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
  DeliveryAdmissionCheck,
} from "./deliveryScheduler.ts";
import {
  drainRecipient,
  offerReplyReminders,
  peerFifoOwed,
  peerNoticeOwed,
  peerNoticeOfferable,
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
import {
  settleSessionDeliveries,
  trackDeliverySettlement,
} from "./deliverySettlement.ts";

/**
 * Drains own their run promises. Observe append to return admission immediately
 * and fence later claims. Lanes interpret their own per-prompt receipts.
 */
function createDeliver() {
  async function deliver(
    session: PromptQueueDriver,
    checkAdmission: DeliveryAdmissionCheck,
    drain: (shouldStart: () => boolean) => Promise<void>,
    peer = false,
  ): Promise<DeliveryResult> {
    const id = session.sessionId;
    if (hasExplicitRecipientAuthority(id)) return "deferred";
    let appended = false;
    let deferred = false;
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
    const drained = Promise.resolve()
      .then(() =>
        drain(() => {
          if (appended) return false;
          if (hasExplicitRecipientAuthority(id)) {
            deferred = true;
            return false;
          }
          const failure = checkAdmission();
          // Preserve the facade's released-driver failure accounting for peers.
          // Other admission refusals return the claim without spending a retry.
          if (peer && failure === "released")
            throw new Error(
              `Session ${session.id} was released from memory; send it again.`,
            );
          return failure === undefined;
        }),
      )
      .then<DeliveryResult>(() => (deferred ? "deferred" : "none"))
      .finally(() => {
        unsubscribe();
      });
    trackDeliverySettlement(id, drained, peer);
    return Promise.race([admitted, drained]);
  }

  return { deliver, settleEarlierDeliveries: settleSessionDeliveries };
}

export function sessionDeliveryLanes(
  background: BackgroundCompletionDelivery,
): {
  lanes: DeliveryLane<PromptQueueDriver>[];
  reminder: DeliveryLane<PromptQueueDriver>;
  deferOnDecline: Readonly<Record<string, readonly string[]>>;
  settleEarlierDeliveries(sessionId: string): Promise<void>;
} {
  const { deliver, settleEarlierDeliveries } = createDeliver();
  return {
    settleEarlierDeliveries,
    // Keep the old queue-to-peer deferral without lane-owned cross-yields.
    // A paused/failed queue no longer owes; other lanes keep their policy.
    deferOnDecline: { "user queue": ["peer fifo", "peer notices"] },
    lanes: [
      {
        name: "handoffs",
        mayJoinRunningTurn: false,
        owes: agentHandoffOwed,
        unavailable: agentHandoffUnavailable,
        deliver: (session, canAdmit) =>
          deliver(session, canAdmit, (shouldStart) =>
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
        deliver: (session, canAdmit) =>
          deliver(session, canAdmit, (shouldStart) =>
            drainPromptQueue(session.sessionId, shouldStart, session),
          ),
      },
      {
        name: "workflow assignments",
        mayJoinRunningTurn: false,
        owes: workflowAssignmentDelivery.owes,
        unavailable: workflowAssignmentDelivery.unavailable,
        deliver: (session, canAdmit) =>
          deliver(session, canAdmit, (shouldStart) =>
            workflowAssignmentDelivery.deliver(session, shouldStart),
          ),
      },
      ...(["fifo", "notices"] as const).map((phase) => ({
        name: `peer ${phase}`,
        mayJoinRunningTurn: false,
        owes: phase === "fifo" ? peerFifoOwed : peerNoticeOwed,
        ...(phase === "notices" ? { offerable: peerNoticeOfferable } : {}),
        unavailable: (id: string, failure: DeliveryAcquisitionFailure) =>
          noteDrainTargetUnavailable(id, failure.reason, phase),
        deliver: (
          session: PromptQueueDriver,
          canAdmit: DeliveryAdmissionCheck,
        ) =>
          deliver(
            session,
            canAdmit,
            (shouldStart) =>
              drainRecipient(session.sessionId, {
                phase,
                driver: session,
                shouldStart,
              }),
            true,
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
        deliver: (session, canAdmit) =>
          deliver(session, canAdmit, (shouldStart) =>
            background.drain(session.sessionId, shouldStart),
          ),
      },
    ],
    reminder: {
      name: "reminders",
      mayJoinRunningTurn: false,
      owes: replyReminderOwed,
      deliver: (session, canAdmit) =>
        deliver(
          session,
          canAdmit,
          (shouldStart) =>
            offerReplyReminders(session.sessionId, {
              driver: session,
              shouldStart,
            }),
          true,
        ),
    },
  };
}
