import type { TimelineAnchor } from "@assistant/shared";
import { approvalMessageId } from "@assistant/shared/objectLinks";
import { approvalForId } from "./pendingApprovals.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import type { SessionLogEntry } from "./session/log/rawEntry.ts";

/**
 * Where an approval card sits, for a jump to it (the composer's pending strip,
 * a `pa://approval/<id>` link).
 *
 * A card is a store-backed overlay, not a log entry, so the anchor pairs the
 * card's OWN row id — the row the transcript flashes — with the index of the
 * turn that proposed it, which is how far back a windowed transcript has to
 * load before that row exists. The turn is found by the proposing tool call;
 * a card without one (or whose call is not in the log) falls back to the first
 * entry written after it, and one created after every entry to the tail —
 * which is where the transcript places it too, so a card whose session still
 * exists always has an anchor.
 */
export function approvalAnchorFor(
  approvalId: string,
): TimelineAnchor | undefined {
  const card = approvalForId(approvalId);
  if (!card || !sessionStore.get(card.sessionId)) return undefined;
  const sourceToolCallId = card.sourceToolCallId;
  const located =
    (sourceToolCallId
      ? sessionRuntime.locateAnchor(card.sessionId, (entry) =>
          entryDeclaresToolCall(entry, sourceToolCallId),
        )
      : undefined) ??
    sessionRuntime.locateAnchor(
      card.sessionId,
      (entry) => Date.parse(entry.createdAt) >= card.createdAt,
    );
  return {
    sessionId: card.sessionId,
    entryId: approvalMessageId(card.id),
    index: located?.index ?? tailIndex(card.sessionId),
  };
}

/**
 * The last row of a session's client timeline, 0 for an empty one. Any row
 * reports the timeline's length, and every conversation message — user,
 * assistant or tool result — projects into one.
 */
function tailIndex(sessionId: string): number {
  const any = sessionRuntime.locateAnchor(
    sessionId,
    (entry) => entry.type === "message",
  );
  return any ? Math.max(any.totalEntryCount - 1, 0) : 0;
}

function entryDeclaresToolCall(
  entry: SessionLogEntry,
  toolCallId: string,
): boolean {
  if (entry.type !== "message" || entry.role !== "assistant") return false;
  return entry.content.some(
    (block) => block.type === "toolCall" && block.toolCallId === toolCallId,
  );
}
