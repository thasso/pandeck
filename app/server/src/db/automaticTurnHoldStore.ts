/**
 * SQL facade for the per-session hold on automatic turns a Stop sets.
 * `automaticTurnHold.ts` owns what the hold means.
 */
import { getDb } from "./index.ts";

export const automaticTurnHoldStore = {
  isHeld(sessionId: string): boolean {
    return Boolean(
      getDb()
        .prepare("SELECT 1 FROM session_automatic_turn_hold WHERE session_id=?")
        .get(sessionId),
    );
  },

  /** Idempotent: a second Stop keeps the first hold's time. */
  hold(sessionId: string): void {
    getDb()
      .prepare(
        "INSERT INTO session_automatic_turn_hold(session_id,held_at_ms) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
      )
      .run(sessionId, Date.now());
  },

  /** Whether there was a hold to lift. */
  release(sessionId: string): boolean {
    return (
      getDb()
        .prepare("DELETE FROM session_automatic_turn_hold WHERE session_id=?")
        .run(sessionId).changes > 0
    );
  },
};
