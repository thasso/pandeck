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
  /**
   * A Stop touched it: saved while its session was held, or owed when a Stop
   * landed. Boot restores it until it is delivered, held or not.
   */
  retained: boolean;
}

interface Row {
  session_id: string;
  item_id: string;
  revision: number;
  disposition: "wake" | "defer";
  retained: number;
}

export const backgroundDeliveryOutboxStore = {
  /** Once retained, a row stays retained. */
  save(row: BackgroundDeliveryOutboxRow): void {
    getDb()
      .prepare(
        "INSERT INTO background_delivery_outbox(session_id,item_id,revision,disposition,retained,created_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,item_id,revision) DO UPDATE SET disposition=excluded.disposition, retained=MAX(retained,excluded.retained)",
      )
      .run(
        row.sessionId,
        row.itemId,
        row.revision,
        row.disposition,
        row.retained ? 1 : 0,
        Date.now(),
      );
  },

  /** A Stop landed: everything this session is owed now outlives a restart. */
  retainSession(sessionId: string): void {
    getDb()
      .prepare(
        "UPDATE background_delivery_outbox SET retained=1 WHERE session_id=?",
      )
      .run(sessionId);
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
          "SELECT session_id,item_id,revision,disposition,retained FROM background_delivery_outbox ORDER BY created_at_ms, rowid",
        )
        .all() as unknown as Row[]
    ).map((r) => ({
      sessionId: r.session_id,
      itemId: r.item_id,
      revision: r.revision,
      disposition: r.disposition,
      retained: r.retained === 1,
    }));
  },

  deleteSession(sessionId: string): void {
    getDb()
      .prepare("DELETE FROM background_delivery_outbox WHERE session_id=?")
      .run(sessionId);
  },
};
