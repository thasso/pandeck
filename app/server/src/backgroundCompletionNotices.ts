/**
 * What a background-work row tells its owner session when it ends, and the
 * durable record of what is still owed (`background_delivery_outbox`).
 *
 * A notice is rebuilt from its row rather than stored, so the outbox holds only
 * identities. That is what lets a fact owed to a session a Stop touched survive
 * a restart (`automaticTurnHold.ts`) until it is delivered — through a Resume
 * too. A fact no Stop touched keeps the old rule and is forgotten at boot: the
 * delivery queue never survived a restart, so no historical job is announced
 * again.
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
        // Owed to a stopped session: it must outlive a restart until it is
        // delivered, whatever the user does with the hold meanwhile.
        retained: automaticTurnsHeld(sessionId),
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
 * Boot: put back every fact a Stop touched that was not yet delivered, in the
 * order it was owed, as it was decided then. "Not held now" never means
 * "delivered": a Resume authorizes delivery, it does not perform it, so a fact
 * released and then cut off by the restart is restored too, and offered at
 * once to a session that is no longer held (one still held waits for Resume).
 * A row no Stop touched is forgotten, as a restart always forgot pending
 * delivery, and so is one whose item is gone or changed revision or owner:
 * it no longer names the fact it was saved for.
 *
 * Delivery is at-least-once across the crash windows: a fact is retired only
 * once its turn resolved (a wake) or its carrying prompt was appended and
 * resolved (a deferred fact), so a restart inside an admitted turn delivers it
 * again; one before admission delivers it the first time.
 */
export function restoreOwedBackgroundDelivery(
  delivery: BackgroundCompletionDelivery,
): { restored: number; forgotten: number } {
  let restored = 0;
  let forgotten = 0;
  const resumed = new Set<string>();
  for (const row of backgroundDeliveryOutboxStore.list()) {
    const item = row.retained
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
    if (!automaticTurnsHeld(row.sessionId)) resumed.add(row.sessionId);
  }
  // Released before the restart, so nothing else will come for these: the
  // usual peer-first drain offers them now (a deferred fact still waits for
  // the session's next turn).
  for (const sessionId of resumed) void delivery.requestDrain(sessionId);
  return { restored, forgotten };
}
