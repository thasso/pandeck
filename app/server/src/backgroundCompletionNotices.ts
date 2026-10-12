/**
 * What a background-work row tells its owner session when it ends, and the
 * durable record of what is still owed (`background_delivery_outbox`).
 *
 * A notice is rebuilt from its row rather than stored, so the outbox holds only
 * identities. That is what lets a fact owed to a session a Stop holds survive a
 * restart (`automaticTurnHold.ts`): boot restores the owed rows of every held
 * session, and forgets the rest — an unheld session never had its delivery
 * queue survive a restart, and does not start now, so no historical job is
 * announced again.
 */
import { automaticTurnsHeld } from "./automaticTurnHold.ts";
import type {
  BackgroundCompletionDelivery,
  BackgroundCompletionNotice,
  BackgroundDeliveryOutbox,
} from "./backgroundWork/completionDelivery.ts";
import { backgroundCompletionDisposition } from "./backgroundWork/deliveryPolicy.ts";
import { BACKGROUND_EVENT_RATE_TERMINAL_REASON } from "./backgroundWork/supervisor.ts";
import { backgroundDeliveryOutboxStore } from "./db/backgroundDeliveryOutboxStore.ts";
import {
  backgroundWorkStore,
  type BackgroundWorkItem,
} from "./db/backgroundWorkStore.ts";
import { errorText } from "./errors.ts";
import { sessionArtifactFile } from "./mcp/toolGroups/packRuntime.ts";

export function backgroundWorkHumanLink(itemId: string): string {
  return `/background-tasks?task=${encodeURIComponent(itemId)}`;
}

/** The card's command facts, exactly as the registry row carries them. */
export function backgroundNoticeCommand(item: BackgroundWorkItem): {
  description?: string;
  command?: string;
  commandTruncated?: boolean;
} {
  return {
    ...(item.description ? { description: item.description } : {}),
    ...(item.command ? { command: item.command } : {}),
    ...(item.commandTruncated ? { commandTruncated: true } : {}),
  };
}

/**
 * The completion notice for a terminal row, or undefined for one that has not
 * ended. `ownerTurnRunning` is the caller's evidence, sampled when the fact
 * became durable (`deliveryPolicy.ts`).
 */
export function completionNoticeOf(
  item: BackgroundWorkItem,
  ownerTurnRunning: boolean,
): BackgroundCompletionNotice | undefined {
  if (
    item.state !== "completed" &&
    item.state !== "failed" &&
    item.state !== "stopped" &&
    item.state !== "lost"
  )
    return undefined;
  const retained = item.evidence?.artifactId
    ? sessionArtifactFile(item.ownerSessionId, item.evidence.artifactId)
    : undefined;
  const output = item.evidence
    ? {
        ...(retained
          ? { path: retained.path, url: retained.artifact.url }
          : {}),
        ...(item.evidence.capturedBytes !== undefined
          ? { capturedBytes: item.evidence.capturedBytes }
          : {}),
        ...(item.evidence.originalBytes !== undefined
          ? { originalBytes: item.evidence.originalBytes }
          : {}),
        ...(item.evidence.truncated !== undefined
          ? { truncated: item.evidence.truncated }
          : {}),
        ...(item.evidence.text !== undefined
          ? { text: item.evidence.text }
          : {}),
        ...(item.evidence.refusalReason
          ? { refusalReason: item.evidence.refusalReason }
          : {}),
      }
    : undefined;
  return {
    itemId: item.id,
    revision: item.revision,
    label: item.label,
    ...backgroundNoticeCommand(item),
    state: item.state,
    backend: item.backend,
    stopRequested: item.stopState !== "none",
    // The supervisor's own constant, compared as a symbol, so the policy learns
    // WHO wanted the stop without either side parsing the other's prose.
    stopOrigin:
      item.terminalReason === BACKGROUND_EVENT_RATE_TERMINAL_REASON
        ? "system"
        : "requester",
    ownerTurnRunning,
    ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
    ...(item.outcomeSummary ? { outcomeSummary: item.outcomeSummary } : {}),
    humanLink: backgroundWorkHumanLink(item.id),
    ...(output ? { output } : {}),
  };
}

/** How a completion reaches the model (`deliveryPolicy.ts`). */
export function completionDisposition(
  notice: BackgroundCompletionNotice,
): "wake" | "defer" {
  return backgroundCompletionDisposition({
    backend: notice.backend,
    stopRequested: notice.stopRequested,
    ...(notice.stopOrigin ? { stopOrigin: notice.stopOrigin } : {}),
    ownerTurnRunning: notice.ownerTurnRunning,
  }).disposition;
}

/**
 * The delivery queue's durable side. A write that fails is reported, never
 * thrown: delivery itself goes on in memory, as it did before the outbox.
 */
export const backgroundDeliveryOutbox: BackgroundDeliveryOutbox = {
  save: (sessionId, notice, disposition) => {
    try {
      backgroundDeliveryOutboxStore.save({
        sessionId,
        itemId: notice.itemId,
        revision: notice.revision,
        disposition,
      });
    } catch (err) {
      console.warn(
        "[background] could not record an owed fact:",
        errorText(err),
      );
    }
  },
  remove: (sessionId, notice) => {
    try {
      backgroundDeliveryOutboxStore.remove(
        sessionId,
        notice.itemId,
        notice.revision,
      );
    } catch (err) {
      console.warn(
        "[background] could not retire an owed fact:",
        errorText(err),
      );
    }
  },
};

/**
 * Boot: put back what a held session is still owed, in the order it was owed,
 * and forget the rest. A row whose item is gone, changed revision or changed
 * owner no longer names the fact it was saved for, and is forgotten too.
 */
export function restoreHeldBackgroundDelivery(
  delivery: BackgroundCompletionDelivery,
): { restored: number; forgotten: number } {
  let restored = 0;
  let forgotten = 0;
  for (const row of backgroundDeliveryOutboxStore.list()) {
    const item = automaticTurnsHeld(row.sessionId)
      ? backgroundWorkStore.getItem(row.itemId)
      : undefined;
    const notice =
      item &&
      item.revision === row.revision &&
      item.ownerSessionId === row.sessionId
        ? completionNoticeOf(item, false)
        : undefined;
    if (!notice) {
      backgroundDeliveryOutboxStore.remove(
        row.sessionId,
        row.itemId,
        row.revision,
      );
      forgotten += 1;
      continue;
    }
    delivery.restore(row.sessionId, notice, row.disposition);
    restored += 1;
  }
  return { restored, forgotten };
}
