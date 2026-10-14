import { permanentAssistantStore } from "./db/permanentAssistantStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { mergedSessionList } from "./harnesses/sessionList.ts";

/** Use the ordinary session projection, including its live harness overlay. */
export async function permanentAssistantReadBoundary(): Promise<{
  updatedAt: number;
  unread: boolean;
}> {
  const id = permanentAssistantStore.sessionId();
  if (!id) return { updatedAt: 0, unread: false };
  const [session] = await mergedSessionList({
    includeArchived: true,
    onlyIds: new Set([id]),
  });
  // A metadata-only bootstrap is not a conversation in the ordinary list.
  return {
    updatedAt: session?.updatedAt ?? 0,
    unread: Boolean(session?.unread),
  };
}

export async function permanentAssistantUnread(): Promise<boolean> {
  return (await permanentAssistantReadBoundary()).unread;
}

/** A successful Slack delivery may acknowledge only the turn it answered. */
export function acknowledgeSlackAssistantTurn(
  sessionId: string,
  baseline: { updatedAt: number; unread: boolean },
  completedAt: number,
): boolean {
  const current = sessionStore.get(sessionId);
  if (!current || permanentAssistantStore.sessionId() !== sessionId)
    return false;
  // Preserve older unread content and anything arriving during Slack delivery.
  if (baseline.unread && current.readAt < baseline.updatedAt) return false;
  if (current.updatedAt !== completedAt) return false;
  return sessionStore.markRead(sessionId, completedAt);
}
