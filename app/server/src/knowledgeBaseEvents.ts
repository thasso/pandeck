/**
 * Broadcaster seam for Knowledge Base browser events. The KB domain remains
 * independent of the session hub; the hub installs the connected-client
 * broadcaster during construction.
 */
import type { ServerMessage } from "@assistant/shared";

export interface KnowledgeBaseBroadcaster {
  /** Deliver to the connections currently showing the KB (topic `knowledge`). */
  broadcast(message: ServerMessage): void;
}

let broadcaster: KnowledgeBaseBroadcaster = {
  broadcast: () => {
    // Unit tests and one-shot KB callers may run without a live hub.
  },
};

export function setKnowledgeBaseBroadcaster(
  next: KnowledgeBaseBroadcaster,
): void {
  broadcaster = next;
}

export function knowledgeBaseBroadcaster(): KnowledgeBaseBroadcaster {
  return broadcaster;
}
