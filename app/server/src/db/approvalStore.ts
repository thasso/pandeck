/**
 * SQL facade for approval cards and session grants (`pendingApprovals.ts` owns
 * the domain). One row per card: `card_json`/`context_json` are the record, the
 * other columns are what reads select by and are rewritten from the card on
 * every write. `seq` is insertion order, which is what "oldest first" means
 * for both cards and grants.
 */
import type { ApprovalCard, ApprovalGrant } from "@assistant/shared";
import { getDb } from "./index.ts";

/** A stored card and its kind-specific execution context. */
export interface StoredApproval {
  card: ApprovalCard;
  context: Record<string, unknown>;
}

const RECORD = "SELECT card_json, context_json FROM approvals";
/** Pending and waiting for the user: an auto-approved card blocks nobody. */
const AWAITING = "status = 'pending' AND auto_approved = 0";
const AUTO = "status = 'pending' AND auto_approved = 1";

/**
 * Every statement a request or list path issues, by name — exported so the
 * query-plan test explains the EXACT SQL this facade runs.
 */
export const APPROVAL_SQL = {
  byId: `${RECORD} WHERE id = ?`,
  bySession: `${RECORD} WHERE session_id = ? ORDER BY seq`,
  // Pinned: without statistics the planner prefers the session index, which
  // walks the session's whole history to find its (usually no) pending cards.
  pendingForSession: `${RECORD} INDEXED BY approvals_pending_idx
    WHERE session_id = ? AND status = 'pending' ORDER BY seq`,
  awaitingSessions: `SELECT DISTINCT session_id FROM approvals WHERE ${AWAITING}`,
  sessionAwaits: `SELECT 1 FROM approvals WHERE session_id = ? AND ${AWAITING} LIMIT 1`,
  autoApprovalIds: `SELECT id FROM approvals WHERE session_id = ? AND ${AUTO} ORDER BY seq`,
  autoApprovalSessions: `SELECT session_id FROM approvals WHERE ${AUTO}
    GROUP BY session_id ORDER BY MIN(seq)`,
  insert: `INSERT OR IGNORE INTO approvals
    (id, session_id, status, auto_approved, created_at_ms, card_json, context_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  update: `UPDATE approvals SET session_id = ?, status = ?, auto_approved = ?,
    created_at_ms = ?, card_json = ?, context_json = ? WHERE id = ?`,
  grantsForSession: `SELECT key, granted_at_ms, source_approval_id FROM approval_grants
    WHERE session_id = ? ORDER BY seq`,
  insertGrant: `INSERT OR IGNORE INTO approval_grants
    (session_id, key, granted_at_ms, source_approval_id) VALUES (?, ?, ?, ?)`,
  deleteGrant: "DELETE FROM approval_grants WHERE session_id = ? AND key = ?",
} as const;

interface RecordRow {
  card_json: string;
  context_json: string;
}

const record = (row: RecordRow): StoredApproval => ({
  card: JSON.parse(row.card_json) as ApprovalCard,
  context: JSON.parse(row.context_json) as Record<string, unknown>,
});

const records = (rows: unknown[]): StoredApproval[] =>
  (rows as RecordRow[]).map(record);

const sessionIds = (rows: unknown[]): string[] =>
  (rows as Array<{ session_id: string }>).map((row) => row.session_id);

function columns(card: ApprovalCard) {
  return [
    card.sessionId,
    String(card.status),
    card.autoApproved ? 1 : 0,
    typeof card.createdAt === "number" ? card.createdAt : 0,
  ] as const;
}

export const approvalStore = {
  get(id: string): StoredApproval | undefined {
    const row = getDb().prepare(APPROVAL_SQL.byId).get(id) as
      RecordRow | undefined;
    return row ? record(row) : undefined;
  },

  /** Append a card; `false` when its id is already stored (the first one stays). */
  insert(stored: StoredApproval): boolean {
    const result = getDb()
      .prepare(APPROVAL_SQL.insert)
      .run(
        stored.card.id,
        ...columns(stored.card),
        JSON.stringify(stored.card),
        JSON.stringify(stored.context),
      );
    return Number(result.changes) > 0;
  },

  /** Replace one stored card (and its context) in place, keeping its position. */
  update(stored: StoredApproval): void {
    getDb()
      .prepare(APPROVAL_SQL.update)
      .run(
        ...columns(stored.card),
        JSON.stringify(stored.card),
        JSON.stringify(stored.context),
        stored.card.id,
      );
  },

  forSession(sessionId: string): StoredApproval[] {
    return records(getDb().prepare(APPROVAL_SQL.bySession).all(sessionId));
  },

  pendingForSession(sessionId: string): StoredApproval[] {
    return records(
      getDb().prepare(APPROVAL_SQL.pendingForSession).all(sessionId),
    );
  },

  awaitingSessionIds(): Set<string> {
    return new Set(
      sessionIds(getDb().prepare(APPROVAL_SQL.awaitingSessions).all()),
    );
  },

  sessionAwaits(sessionId: string): boolean {
    return (
      getDb().prepare(APPROVAL_SQL.sessionAwaits).get(sessionId) !== undefined
    );
  },

  /** A session's auto-approved cards still to run, oldest first. */
  autoApprovalIds(sessionId: string): string[] {
    return (
      getDb().prepare(APPROVAL_SQL.autoApprovalIds).all(sessionId) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  },

  /** Sessions holding an auto-approval still to run, by their oldest card. */
  autoApprovalSessionIds(): string[] {
    return sessionIds(getDb().prepare(APPROVAL_SQL.autoApprovalSessions).all());
  },

  /** The session's grants, oldest first. */
  grantsForSession(sessionId: string): ApprovalGrant[] {
    const rows = getDb()
      .prepare(APPROVAL_SQL.grantsForSession)
      .all(sessionId) as Array<{
      key: string;
      granted_at_ms: number;
      source_approval_id: string;
    }>;
    return rows.map((row) => ({
      key: row.key,
      grantedAt: row.granted_at_ms,
      sourceApprovalId: row.source_approval_id,
    }));
  },

  /** Record a grant; `false` when the session already holds that key. */
  insertGrant(sessionId: string, grant: ApprovalGrant): boolean {
    const result = getDb()
      .prepare(APPROVAL_SQL.insertGrant)
      .run(sessionId, grant.key, grant.grantedAt, grant.sourceApprovalId);
    return Number(result.changes) > 0;
  },

  deleteGrant(sessionId: string, key: string): void {
    getDb().prepare(APPROVAL_SQL.deleteGrant).run(sessionId, key);
  },
};
