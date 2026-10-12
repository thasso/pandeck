/**
 * SQL facade for delegation-failure notices: what a coordinator is owed when
 * work it delegated stopped on a failure (`delegationFailureNotice.ts`).
 *
 * Identities and safe structured facts only. A row never holds a provider
 * message, prompt, tool output or credential: the category is a fixed
 * vocabulary, the reset time is a harness-reported structured field, and the
 * affected requests are peer-prompt ids rendered from their own rows.
 */
import { randomUUID } from "node:crypto";
import { getDb, inDbTransaction } from "./index.ts";

export type DelegationFailureCategory =
  | "auth"
  | "usage_limit"
  | "rate_limit"
  | "content_policy"
  | "provider_error"
  | "delivery";

/** How the coordinator is known to be waiting on the child. */
export type DelegationFailureRoute = "spawn" | "request";

export interface DelegationFailureNoticeInput {
  /** The failed run or the abandoned delivery; one notice per coordinator each. */
  incidentKey: string;
  childSessionId: string;
  coordinatorSessionId: string;
  route: DelegationFailureRoute;
  category: DelegationFailureCategory;
  resetAt?: number;
  /** Peer prompts from the coordinator the failure leaves unanswered. */
  requestIds: readonly string[];
  /** The peer chain a recovery send from the notice turn continues. */
  anchor?: { chainId: string; conversationId: string; hop: number };
  failedAt: number;
}

export interface DelegationFailureNotice extends DelegationFailureNoticeInput {
  id: string;
  createdAt: number;
}

interface Row {
  id: string;
  incident_key: string;
  child_session_id: string;
  coordinator_session_id: string;
  route: DelegationFailureRoute;
  category: DelegationFailureCategory;
  reset_at_ms: number | null;
  request_ids_json: string;
  chain_id: string | null;
  conversation_id: string | null;
  hop: number | null;
  failed_at_ms: number;
  created_at_ms: number;
}

const PENDING = "delivered_at_ms IS NULL AND dropped_at_ms IS NULL";

function parseIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function map(r: Row): DelegationFailureNotice {
  return {
    id: r.id,
    incidentKey: r.incident_key,
    childSessionId: r.child_session_id,
    coordinatorSessionId: r.coordinator_session_id,
    route: r.route,
    category: r.category,
    ...(r.reset_at_ms !== null ? { resetAt: r.reset_at_ms } : {}),
    requestIds: parseIds(r.request_ids_json),
    ...(r.chain_id !== null && r.conversation_id !== null && r.hop !== null
      ? {
          anchor: {
            chainId: r.chain_id,
            conversationId: r.conversation_id,
            hop: r.hop,
          },
        }
      : {}),
    failedAt: r.failed_at_ms,
    createdAt: r.created_at_ms,
  };
}

/**
 * Record the notices one failure owes, atomically, joining the caller's
 * transaction when one is open (a peer prompt giving up on delivery). A repeat
 * of the same incident for the same coordinator is ignored, so a duplicate
 * event or a recovery pass cannot announce a failure twice. Returns the rows
 * actually written.
 */
function record(
  inputs: readonly DelegationFailureNoticeInput[],
  now = Date.now(),
): DelegationFailureNotice[] {
  if (inputs.length === 0) return [];
  return inDbTransaction(() => {
    const insert = getDb().prepare(
      `INSERT INTO delegation_failure_notices (
         id, incident_key, child_session_id, coordinator_session_id, route,
         category, reset_at_ms, request_ids_json, chain_id, conversation_id,
         hop, failed_at_ms, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (incident_key, coordinator_session_id) DO NOTHING`,
    );
    const written: DelegationFailureNotice[] = [];
    for (const input of inputs) {
      const id = randomUUID();
      const result = insert.run(
        id,
        input.incidentKey,
        input.childSessionId,
        input.coordinatorSessionId,
        input.route,
        input.category,
        input.resetAt ?? null,
        JSON.stringify(input.requestIds),
        input.anchor?.chainId ?? null,
        input.anchor?.conversationId ?? null,
        input.anchor?.hop ?? null,
        input.failedAt,
        now,
      );
      if (result.changes > 0) written.push({ ...input, id, createdAt: now });
    }
    return written;
  });
}

/**
 * Whether an incident was recorded at all — for any coordinator, delivered or
 * not. One transaction writes every notice of an incident, so a recorded one
 * is complete: a replay must not add to it.
 */
function hasIncident(incidentKey: string): boolean {
  return (
    getDb()
      .prepare(
        "SELECT 1 FROM delegation_failure_notices WHERE incident_key = ? LIMIT 1",
      )
      .get(incidentKey) !== undefined
  );
}

/** What a coordinator is still owed, oldest first. */
function pendingFor(coordinatorSessionId: string): DelegationFailureNotice[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM delegation_failure_notices
          WHERE coordinator_session_id = ? AND ${PENDING}
          ORDER BY created_at_ms, rowid`,
      )
      .all(coordinatorSessionId) as unknown as Row[]
  ).map(map);
}

function hasPendingFor(coordinatorSessionId: string): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM delegation_failure_notices
          WHERE coordinator_session_id = ? AND ${PENDING} LIMIT 1`,
      )
      .get(coordinatorSessionId) !== undefined
  );
}

/** Every coordinator still owed a notice, so boot can reach cold ones. */
function coordinatorsWithPending(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT coordinator_session_id FROM delegation_failure_notices
          WHERE ${PENDING}`,
      )
      .all() as { coordinator_session_id: string }[]
  ).map((r) => r.coordinator_session_id);
}

/**
 * Retire notices whose turn was admitted to the coordinator's log. Written
 * from the append itself, so only a crash between the log write and this one
 * delivers a notice twice.
 */
function markDelivered(ids: readonly string[], now = Date.now()): void {
  if (ids.length === 0) return;
  inDbTransaction(() => {
    const stmt = getDb().prepare(
      `UPDATE delegation_failure_notices SET delivered_at_ms = ?
        WHERE id = ? AND ${PENDING}`,
    );
    for (const id of ids) stmt.run(now, id);
  });
}

/** Retire notices that must not be delivered after all, with the reason. */
function drop(ids: readonly string[], reason: string, now = Date.now()): void {
  if (ids.length === 0) return;
  inDbTransaction(() => {
    const stmt = getDb().prepare(
      `UPDATE delegation_failure_notices
          SET dropped_at_ms = ?, drop_reason = ?
        WHERE id = ? AND ${PENDING}`,
    );
    for (const id of ids) stmt.run(now, reason, id);
  });
}

/** A deleted session is owed nothing and owes nothing to report about. */
function dropForSession(sessionId: string, reason: string, now = Date.now()) {
  getDb()
    .prepare(
      `UPDATE delegation_failure_notices
          SET dropped_at_ms = ?, drop_reason = ?
        WHERE (coordinator_session_id = ? OR child_session_id = ?) AND ${PENDING}`,
    )
    .run(now, reason, sessionId, sessionId);
}

/**
 * Forget retired rows older than the cutoff. Pending rows are never pruned,
 * and neither is any row of an incident in `keepIncidents` — the failures the
 * journal still holds, whose rows are what tells a replay they were recorded.
 */
function pruneRetired(
  cutoffMs: number,
  keepIncidents: ReadonlySet<string>,
): number {
  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT id, incident_key FROM delegation_failure_notices
        WHERE COALESCE(delivered_at_ms, dropped_at_ms) < ?`,
    )
    .all(cutoffMs) as { id: string; incident_key: string }[];
  const doomed = candidates.filter((r) => !keepIncidents.has(r.incident_key));
  if (doomed.length === 0) return 0;
  return inDbTransaction(() => {
    const stmt = db.prepare(
      "DELETE FROM delegation_failure_notices WHERE id = ?",
    );
    let removed = 0;
    for (const r of doomed) removed += Number(stmt.run(r.id).changes);
    return removed;
  });
}

export const delegationFailureNoticeStore = {
  record,
  hasIncident,
  pendingFor,
  hasPendingFor,
  coordinatorsWithPending,
  markDelivered,
  drop,
  dropForSession,
  pruneRetired,
};
