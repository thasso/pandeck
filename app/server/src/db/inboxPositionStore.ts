/**
 * Manual Sessions inbox order (0075): the one write behind `setInboxPositions`.
 * Sessions and Workflow Runs are ordered in ONE inbox list, so one drop may
 * place both kinds, and a renumbering places many — all in one transaction.
 */
import { getDb } from "./index.ts";
import { touchSessionRows } from "./sessionListChanges.ts";

export interface InboxPlacement {
  sessions: ReadonlyArray<{ id: string; position: number }>;
  runs: ReadonlyArray<{ id: number; position: number }>;
}

/**
 * Write every placement, or none. Answers false when any row is missing (a
 * deleted session, an unknown run) or the database refuses: a renumbered list
 * half applied would interleave the old and new numbering, and put cards in an
 * order nobody dragged them to. Never touches `updated_at_ms` — where a card
 * sits is not activity on it.
 */
export function setInboxPositions(placement: InboxPlacement): boolean {
  const db = getDb();
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    return false;
  }
  try {
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
    db.exec("COMMIT");
    touchSessionRows(placement.sessions.map((placed) => placed.id));
    return true;
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    return false;
  }
}
