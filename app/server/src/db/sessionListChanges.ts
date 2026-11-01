/**
 * The one seam through which every write that can change a session-list row
 * (`SessionListItem`) says WHICH rows (`docs/session-list.md`, "Touched
 * rows"). The writer calls it AT THE WRITE SITE, synchronously, inside its
 * transaction when one is open, before the writing function returns, and names
 * every session whose row the write may change, fan-out included: the
 * counterparts of a peer request, a coordinator's other waiting children, the
 * sessions on either end of an edge. Over-touching costs one row rebuild;
 * under-touching leaves a stale row, which the `sessions` topic's test-mode
 * audit records as an invariant violation (`sessionsTopic.ts`).
 *
 * A touch IS the revision bump: it stamps each id with a fresh
 * `session_list_revision` through the change set, in the write's transaction
 * when one is open, and the committed ids report into the `sessions` kernel
 * (`docs/state-sync.md`).
 *
 * Deferred reporting (`void import(…).then(…)`, a post-publish listener) is not
 * a touch: another flush could see the change first.
 *
 * In `db/` because stores here never import upward; what only the topic module
 * knows (the live registries, the audit) it registers here.
 */
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_SESSION_SCOPE } from "@assistant/shared";
import { touchStateTopic, type StateTopicWrites } from "./changeSet.ts";
import { dbIsOpen, getDb, onDbClosed } from "./index.ts";

/** Ids bound per statement: a global touch names every live session. */
const IDS_PER_STATEMENT = 500;

/** The `sessions` topic's revisions, one row per session ever touched. */
export const sessionsWrites: StateTopicWrites = {
  topic: "sessions",
  sequence: "session_list_revision",
  stamp: (ids, revision) => {
    const db = getDb();
    for (let start = 0; start < ids.length; start += IDS_PER_STATEMENT) {
      const chunk = ids.slice(start, start + IDS_PER_STATEMENT);
      db.prepare(
        `INSERT INTO session_list_revisions (session_id, revision)
         VALUES ${chunk.map(() => "(?, ?)").join(", ")}
         ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision`,
      ).run(...(chunk.flatMap((id) => [id, revision]) as never[]));
    }
  },
};

/** `{id → revision}` for the ids that were ever touched, by primary key. */
export function sessionListRevisions(
  ids: readonly string[],
  db: DatabaseSync = getDb(),
): Map<string, number> {
  const revisions = new Map<string, number>();
  for (let start = 0; start < ids.length; start += IDS_PER_STATEMENT) {
    const chunk = ids.slice(start, start + IDS_PER_STATEMENT);
    const rows = db
      .prepare(
        `SELECT session_id, revision FROM session_list_revisions
         WHERE session_id IN (${chunk.map(() => "?").join(", ")})`,
      )
      .all(...(chunk as never[])) as { session_id: string; revision: number }[];
    for (const row of rows) revisions.set(row.session_id, row.revision);
  }
  return revisions;
}

/**
 * Ids whose `session_index` row is tombstoned. Rows are never hard-deleted,
 * so a tombstone is the only stored reason a session can never list again.
 */
export function tombstonedSessionIds(ids: readonly string[]): Set<string> {
  const gone = new Set<string>();
  const db = getDb();
  for (let start = 0; start < ids.length; start += IDS_PER_STATEMENT) {
    const chunk = ids.slice(start, start + IDS_PER_STATEMENT);
    const rows = db
      .prepare(
        `SELECT id FROM session_index
         WHERE deleted_at_ms IS NOT NULL
           AND id IN (${chunk.map(() => "?").join(", ")})`,
      )
      .all(...(chunk as never[])) as { id: string }[];
    for (const row of rows) gone.add(row.id);
  }
  return gone;
}

/** What the `sessions` topic module registers (`sessionsTopic.ts`). */
interface SessionListHooks {
  /** Every id the pi and Claude live registries hold now. */
  liveIds(): Iterable<string>;
  /** A global touch stamped its superset: its publication is now owed. */
  globalTouched(reason: string): void;
  /** The database closed: nothing stamped before describes what opens next. */
  invalidated(reason: string): void;
}

let hooks: SessionListHooks | undefined;

export function setSessionListHooks(next: SessionListHooks): void {
  hooks = next;
}

/** Test observer of every touch; publication never depends on it. */
interface SessionListObserver {
  touch(ids: ReadonlySet<string>): void;
  touchAll(reason: string): void;
}

let observer: SessionListObserver | undefined;

/**
 * Test seam: observe touches (`test/sessionRowTouches.ts`). Returns the
 * observer it replaced, so a recorder can forward to it and put it back.
 */
export function setSessionListSink(
  next: SessionListObserver | undefined,
): SessionListObserver | undefined {
  const previous = observer;
  observer = next;
  return previous;
}

/** Report, and stamp, the sessions whose list row this write may have changed. */
export function touchSessionRows(
  ids: Iterable<string | null | undefined>,
): void {
  const touched = new Set<string>();
  for (const id of ids) if (id) touched.add(id);
  if (touched.size === 0) return;
  observer?.touch(touched);
  touchStateTopic(sessionsWrites, [...touched]);
}

/**
 * Report a change to an input every row reads (a setting, the model catalog).
 * Only for triggers with no bounded id set; a write that knows its sessions
 * names them.
 *
 * With the database open it stamps a superset of the live projection in one
 * change set (every unarchived, untombstoned user-scope row plus every live
 * registry id; a non-member among them publishes a harmless `delete`) and
 * marks the global publication owed. Archived rows are not stamped: the
 * archived slice picks such a change up at its next re-read. With the
 * database closed it never opens it: it only invalidates.
 */
export function touchAllSessionRows(reason: string): void {
  observer?.touchAll(reason);
  if (!dbIsOpen()) {
    invalidateSessionList(reason);
    return;
  }
  const ids = new Set(
    (
      getDb()
        .prepare(
          `SELECT id FROM session_index
           WHERE scope = ? AND archived_at_ms IS NULL
             AND deleted_at_ms IS NULL`,
        )
        .all(DEFAULT_SESSION_SCOPE) as { id: string }[]
    ).map((row) => row.id),
  );
  for (const id of hooks?.liveIds() ?? []) ids.add(id);
  touchStateTopic(sessionsWrites, [...ids]);
  hooks?.globalTouched(reason);
}

/**
 * The database closed, or its rows were replaced behind the stores: forget
 * what was captured from it. No database access.
 */
function invalidateSessionList(reason: string): void {
  hooks?.invalidated(reason);
}

onDbClosed(() => invalidateSessionList("database closed"));
