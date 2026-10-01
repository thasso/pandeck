/**
 * SQL facade for the durable operation-idempotency ledger (Task 91). Maps a
 * trusted operation-identity key → the card id it produced, so an exact retry of
 * the same mutation is a no-op that returns the prior result. Pure persistence.
 */
import { getDb } from "./index.ts";

export const memoryOperationStore = {
  /** The card id a prior application of `opKey` produced, if any. */
  cardIdFor(opKey: string): string | undefined {
    const row = getDb()
      .prepare("SELECT card_id FROM memory_operations WHERE op_key = ?")
      .get(opKey) as { card_id?: string } | undefined;
    return row?.card_id ?? undefined;
  },

  /** Record that `opKey` produced `cardId`. Idempotent (INSERT OR IGNORE). */
  record(opKey: string, cardId: string, atMs: number): void {
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO memory_operations (op_key, card_id, created_at_ms) VALUES (?, ?, ?)",
      )
      .run(opKey, cardId, atMs);
  },

  /**
   * Prune ledger rows older than the retention cutoff so it cannot grow forever.
   * Retention is far longer than any realistic retry/crash-recovery window, so
   * idempotency for genuine retries is preserved. Returns how many were removed.
   */
  prune(cutoffMs: number): number {
    return Number(
      getDb()
        .prepare("DELETE FROM memory_operations WHERE created_at_ms < ?")
        .run(cutoffMs).changes,
    );
  },
};
