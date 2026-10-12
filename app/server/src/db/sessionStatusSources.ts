/**
 * Read-only SQL the session status digest (`sessionStatus/digest.ts`) needs and
 * no store already answers. Everything else it reads goes through the owning
 * store.
 */
import { getDb } from "./index.ts";

/** A spawn/fork edge touching one session, from that session's side. */
interface SessionLinkEdge {
  otherSessionId: string;
  relation: "spawned" | "forked";
  /** `child`: the other session was started by this one; `parent`: it started this one. */
  direction: "child" | "parent";
}

/** Ids of the live Tasks a session created, oldest first. */
function tasksCreatedBy(sessionId: string): number[] {
  return (
    getDb()
      .prepare(
        "SELECT id FROM tasks WHERE source_session_id = ? AND deleted_at_ms IS NULL ORDER BY id",
      )
      .all(sessionId) as Array<{ id: number }>
  ).map((row) => row.id);
}

/**
 * The spawned and forked sessions on either side of one session. Internal
 * helpers (title generation) are not work the owner would recognize, so they
 * are left out.
 */
function linkEdges(sessionId: string): SessionLinkEdge[] {
  const rows = getDb()
    .prepare(
      `SELECT parent_session_id, child_session_id, relation_type
         FROM session_links
        WHERE (parent_session_id = ? OR child_session_id = ?)
          AND relation_type IN ('spawned', 'forked')
        ORDER BY created_at_ms`,
    )
    .all(sessionId, sessionId) as Array<{
    parent_session_id: string;
    child_session_id: string;
    relation_type: "spawned" | "forked";
  }>;
  return rows.map((row) =>
    row.parent_session_id === sessionId
      ? {
          otherSessionId: row.child_session_id,
          relation: row.relation_type,
          direction: "child",
        }
      : {
          otherSessionId: row.parent_session_id,
          relation: row.relation_type,
          direction: "parent",
        },
  );
}

export const sessionStatusSources = { tasksCreatedBy, linkEdges };
