/**
 * SQL facade for the per-session hold on automatic turns a Stop sets.
 * `automaticTurnHold.ts` owns what the hold means.
 */
import { getDb, withDbTransaction } from "./index.ts";

export const automaticTurnHoldStore = {
  isHeld(sessionId: string): boolean {
    return this.generation(sessionId) !== undefined;
  },

  /** The current hold's generation, or undefined when nothing is held. */
  generation(sessionId: string): number | undefined {
    const row = getDb()
      .prepare(
        "SELECT generation FROM session_automatic_turn_hold WHERE session_id=?",
      )
      .get(sessionId) as { generation: number } | undefined;
    return row?.generation;
  },

  /**
   * Hold the session under a NEW generation, also when it is already held: a
   * resume authorized under the previous Stop must not lift this one.
   */
  hold(sessionId: string): number {
    const db = getDb();
    return withDbTransaction(() => {
      const generation = Number(
        db
          .prepare("INSERT INTO automatic_turn_hold_generation DEFAULT VALUES")
          .run().lastInsertRowid,
      );
      // AUTOINCREMENT keeps the sequence; the row itself is not needed.
      db.prepare(
        "DELETE FROM automatic_turn_hold_generation WHERE generation=?",
      ).run(generation);
      db.prepare(
        "INSERT INTO session_automatic_turn_hold(session_id,held_at_ms,generation) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET held_at_ms=excluded.held_at_ms, generation=excluded.generation",
      ).run(sessionId, Date.now(), generation);
      return generation;
    });
  },

  /** Lift whatever hold there is. Whether there was one. */
  release(sessionId: string): boolean {
    return (
      getDb()
        .prepare("DELETE FROM session_automatic_turn_hold WHERE session_id=?")
        .run(sessionId).changes > 0
    );
  },

  /** Lift the hold only if it is still the one of this generation. */
  releaseGeneration(sessionId: string, generation: number): boolean {
    return (
      getDb()
        .prepare(
          "DELETE FROM session_automatic_turn_hold WHERE session_id=? AND generation=?",
        )
        .run(sessionId, generation).changes > 0
    );
  },
};
