import type { DisplayMessage } from "@assistant/shared";

/**
 * Rows that describe a moment in time rather than durable transcript content:
 * the in-flight stream is projected as one trailing message with the CONSTANT
 * id "live", and optimistic prompts as `creq-<clientRequestId>`. A cached copy
 * of such a row can collide with a later turn's row of the same id — a preview
 * saved mid-turn ends with "live", which matches the CURRENT turn's streaming
 * row and would anchor the merge below at the end of the live list, truncating
 * the displayed transcript to the stale preview until the turn completes. They
 * must never be persisted in previews or used as merge anchors.
 */
export function isTransientMessageId(id: string): boolean {
  return id === "live" || id.startsWith("creq-");
}

/**
 * Preserve an instantly-painted cached transcript prefix while adding any newer
 * rows already present in live client state. Only durable rows participate: the
 * preview's transient rows are dropped and the merge anchors on its last
 * DURABLE id. If the cached prefix no longer overlaps the live transcript,
 * prefer the authoritative live rows wholesale.
 */
export function appendLiveMessagesAfterPreview(
  previewMessages: DisplayMessage[],
  liveMessages: DisplayMessage[],
): DisplayMessage[] {
  const durablePreview = previewMessages.filter(
    (message) => !isTransientMessageId(message.id),
  );
  if (durablePreview.length === 0) return liveMessages;
  const liveIndexById = new Map(
    liveMessages.map((message, index) => [message.id, index]),
  );
  const lastPreviewId = durablePreview[durablePreview.length - 1]?.id;
  const lastLiveIndex = lastPreviewId
    ? liveIndexById.get(lastPreviewId)
    : undefined;
  if (lastLiveIndex === undefined) return liveMessages;
  const previewIds = new Set(durablePreview.map((message) => message.id));
  return [
    ...durablePreview,
    ...liveMessages
      .slice(lastLiveIndex + 1)
      .filter((message) => !previewIds.has(message.id)),
  ];
}
