/**
 * Broadcaster seam for memory browser invalidations (Task 100). The memory
 * domain stays independent of the session hub; the hub installs the
 * connected-client broadcaster during construction and this module subscribes to
 * the domain change + load events, emitting compact targeted invalidations so
 * open panels refetch authoritative rows (never bloating session-list payloads).
 */
import type { ServerMessage } from "@assistant/shared";
import { onMemoryChange } from "./memory/memoryService.ts";
import { onMemoryLoad } from "./memory/memoryRuntime.ts";

export interface MemoryBroadcaster {
  broadcastAll(message: ServerMessage): void;
}

let broadcaster: MemoryBroadcaster = {
  broadcastAll: () => {
    // tests / one-shot callers may run without a live hub.
  },
};
let wired = false;

export function setMemoryBroadcaster(next: MemoryBroadcaster): void {
  broadcaster = next;
  if (wired) return;
  wired = true;
  onMemoryChange((event) =>
    broadcaster.broadcastAll({ type: "memoryInvalidated", ids: [event.id] }),
  );
  onMemoryLoad((event) =>
    broadcaster.broadcastAll({
      type: "memoryLoadInvalidated",
      sessionId: event.sessionId,
    }),
  );
}
