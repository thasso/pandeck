/** Atomic manual Attention ordering across sessions, runs and Initiatives. */
import { getDb } from "./index.ts";
import { initiativeStore } from "./initiativeStore.ts";

export interface InboxPlacement {
  sessions: ReadonlyArray<{ id: string; position: number }>;
  runs: ReadonlyArray<{ id: number; position: number }>;
  initiatives?: ReadonlyArray<{ id: number; position: number }>;
}

/**
 * Write every placement, or none. Missing rows refuse the whole drop. Positions
 * are not activity: preserve timestamps and attention acknowledgements. The
 * Initiative mutation stamps and notifies touched Initiatives after COMMIT.
 */
export function setInboxPositions(placement: InboxPlacement): boolean {
  try {
    initiativeStore.mutation((touch) => {
      const db = getDb();
      const session = db.prepare(
        "UPDATE session_index SET inbox_position = ? WHERE id = ? AND deleted_at_ms IS NULL",
      );
      for (const { id, position } of placement.sessions)
        if (session.run(position, id).changes === 0)
          throw new Error("session row not updated");
      const run = db.prepare(
        "UPDATE workflow_runs SET inbox_position = ? WHERE id = ?",
      );
      for (const { id, position } of placement.runs)
        if (run.run(position, id).changes === 0)
          throw new Error("run row not updated");
      const initiative = db.prepare(
        "UPDATE initiatives SET inbox_position = ? WHERE id = ? AND deleted_at_ms IS NULL",
      );
      for (const { id, position } of placement.initiatives ?? []) {
        if (initiative.run(position, id).changes === 0)
          throw new Error("Initiative row not updated");
        touch.add(id);
      }
    }, false);
    return true;
  } catch {
    return false;
  }
}
