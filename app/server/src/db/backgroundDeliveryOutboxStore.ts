/**
 * SQL facade for background completions owed to a session but not yet
 * delivered. Identities only: `index.ts` rebuilds each notice from its
 * background-work row (`backgroundWorkStore`), which keeps this table free of
 * commands, paths and output.
 */
import { getDb } from "./index.ts";

export interface BackgroundDeliveryOutboxRow {
  sessionId: string;
  itemId: string;
  revision: number;
  disposition: "wake" | "defer";
}

interface Row {
  session_id: string;
  item_id: string;
  revision: number;
  disposition: "wake" | "defer";
}

export const backgroundDeliveryOutboxStore = {
  save(row: BackgroundDeliveryOutboxRow): void {
    getDb()
      .prepare(
        "INSERT INTO background_delivery_outbox(session_id,item_id,revision,disposition,created_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(session_id,item_id,revision) DO UPDATE SET disposition=excluded.disposition",
      )
      .run(
        row.sessionId,
        row.itemId,
        row.revision,
        row.disposition,
        Date.now(),
      );
  },

  remove(sessionId: string, itemId: string, revision: number): void {
    getDb()
      .prepare(
        "DELETE FROM background_delivery_outbox WHERE session_id=? AND item_id=? AND revision=?",
      )
      .run(sessionId, itemId, revision);
  },

  /** Every owed completion, oldest first. */
  list(): BackgroundDeliveryOutboxRow[] {
    return (
      getDb()
        .prepare(
          "SELECT session_id,item_id,revision,disposition FROM background_delivery_outbox ORDER BY created_at_ms, rowid",
        )
        .all() as unknown as Row[]
    ).map((r) => ({
      sessionId: r.session_id,
      itemId: r.item_id,
      revision: r.revision,
      disposition: r.disposition,
    }));
  },

  deleteSession(sessionId: string): void {
    getDb()
      .prepare("DELETE FROM background_delivery_outbox WHERE session_id=?")
      .run(sessionId);
  },
};
