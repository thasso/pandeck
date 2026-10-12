/**
 * The manual Sessions inbox order: what a `setInboxPositions` command asks the
 * store to write. `validateClientMessage` has already checked its shape.
 */
import type { InboxPositionEntry } from "@assistant/shared";
import type { InboxPlacement } from "./db/inboxPositionStore.ts";

/**
 * The placement `positions` asks for, or why it is refused. A later entry for
 * the same item wins, so a client that lists an item twice gets what it said
 * last rather than a write that depends on row order.
 */
export function parseInboxPlacement(
  positions: readonly InboxPositionEntry[],
): InboxPlacement | { error: string } {
  const sessions = new Map<string, number>();
  const runs = new Map<number, number>();
  for (const entry of positions) {
    if (entry.kind === "session") {
      sessions.set(entry.id, entry.position);
      continue;
    }
    const id = Number(entry.runId);
    if (!Number.isSafeInteger(id) || id <= 0)
      return {
        error: `workflow run ${JSON.stringify(entry.runId)} does not exist`,
      };
    runs.set(id, entry.position);
  }
  return {
    sessions: [...sessions].map(([id, position]) => ({ id, position })),
    runs: [...runs].map(([id, position]) => ({ id, position })),
  };
}
