/**
 * The day Tempo-plan store (Task 138, plan Decision #7). Structured proposal
 * rows with a SERIALIZED state machine where exactly one transition may win —
 * the v1 safety requirement. Every state change is a status-guarded UPDATE
 * (`WHERE id=? AND status IN (...)`); SQLite serializes the write, so a racing
 * approve and cancel cannot both succeed: the loser's guard no longer matches
 * and it changes zero rows. The row id is the Tempo `clientId`; durable linkage
 * (proposal/result entry ids + returned worklog id) lives on the row so
 * reconciliation against real Tempo worklogs is deterministic.
 */
import { getDb } from "./index.ts";

export type TempoProposalStatus =
  | "proposed"
  | "user-edited"
  | "dropped"
  | "pending-approval"
  | "executing"
  | "executed"
  | "partial"
  | "failed"
  | "cancelled"
  | "declined";

export interface TempoProposalRow {
  id: string;
  date: string;
  issueKey: string;
  startTime: string | null;
  durationSeconds: number;
  activityKey: string | null;
  description: string | null;
  evidence: string[];
  status: TempoProposalStatus;
  proposalEntryId: string | null;
  resultEntryId: string | null;
  resultWorklogId: string | null;
  updatedAt: number;
}

interface DbRow {
  id: string;
  date: string;
  issue_key: string;
  start_time: string | null;
  duration_seconds: number;
  activity_key: string | null;
  description: string | null;
  evidence_json: string;
  status: TempoProposalStatus;
  proposal_entry_id: string | null;
  result_entry_id: string | null;
  result_worklog_id: string | null;
  updated_at_ms: number;
}

function toRow(row: DbRow): TempoProposalRow {
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(row.evidence_json) as unknown;
    if (Array.isArray(parsed))
      evidence = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* keep [] */
  }
  return {
    id: row.id,
    date: row.date,
    issueKey: row.issue_key,
    startTime: row.start_time,
    durationSeconds: row.duration_seconds,
    activityKey: row.activity_key,
    description: row.description,
    evidence,
    status: row.status,
    proposalEntryId: row.proposal_entry_id,
    resultEntryId: row.result_entry_id,
    resultWorklogId: row.result_worklog_id,
    updatedAt: row.updated_at_ms,
  };
}

export interface UpsertProposalInput {
  id: string;
  date: string;
  issueKey: string;
  startTime?: string | null;
  durationSeconds: number;
  activityKey?: string | null;
  description?: string | null;
  evidence?: string[];
}

/**
 * Insert a fresh `proposed` row, or refresh an existing one's fields. A re-run
 * MUST NOT clobber a user's intent: rows in `user-edited`, `dropped`, or any
 * terminal/in-flight state are preserved untouched (only genuinely new rows and
 * still-`proposed` rows are (re)written).
 */
export function upsertProposal(input: UpsertProposalInput): TempoProposalRow {
  const existing = getProposal(input.id);
  if (existing && existing.status !== "proposed") return existing;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO day_tempo_proposals (id, date, issue_key, start_time, duration_seconds, activity_key, description, evidence_json, status, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
       ON CONFLICT(id) DO UPDATE SET date=excluded.date, issue_key=excluded.issue_key, start_time=excluded.start_time,
         duration_seconds=excluded.duration_seconds, activity_key=excluded.activity_key, description=excluded.description,
         evidence_json=excluded.evidence_json, updated_at_ms=excluded.updated_at_ms`,
    )
    .run(
      input.id,
      input.date,
      input.issueKey,
      input.startTime ?? null,
      input.durationSeconds,
      input.activityKey ?? null,
      input.description ?? null,
      JSON.stringify(input.evidence ?? []),
      now,
    );
  return getProposal(input.id)!;
}

export function getProposal(id: string): TempoProposalRow | null {
  const row = getDb()
    .prepare("SELECT * FROM day_tempo_proposals WHERE id = ?")
    .get(id) as DbRow | undefined;
  return row ? toRow(row) : null;
}

export function listProposalsForDate(date: string): TempoProposalRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM day_tempo_proposals WHERE date = ? ORDER BY updated_at_ms, id",
    )
    .all(date) as unknown as DbRow[];
  return rows.map(toRow);
}

/** Atomic status-guarded transition. Returns true only when THIS call moved the row. */
function transition(
  id: string,
  from: TempoProposalStatus[],
  to: TempoProposalStatus,
  extra?: Partial<
    Pick<
      TempoProposalRow,
      "resultWorklogId" | "resultEntryId" | "proposalEntryId"
    >
  >,
): boolean {
  const placeholders = from.map(() => "?").join(", ");
  const sets = ["status = ?", "updated_at_ms = ?"];
  const params: Array<string | number | null> = [to, Date.now()];
  if (extra && "resultWorklogId" in extra) {
    sets.push("result_worklog_id = ?");
    params.push(extra.resultWorklogId ?? null);
  }
  if (extra && "resultEntryId" in extra) {
    sets.push("result_entry_id = ?");
    params.push(extra.resultEntryId ?? null);
  }
  if (extra && "proposalEntryId" in extra) {
    sets.push("proposal_entry_id = ?");
    params.push(extra.proposalEntryId ?? null);
  }
  const info = getDb()
    .prepare(
      `UPDATE day_tempo_proposals SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(...params, id, ...from);
  return Number(info.changes) > 0;
}

/** User edits a row (preserves the edit across re-runs). */
export function markUserEdited(
  id: string,
  patch: Partial<UpsertProposalInput>,
): boolean {
  const sets: string[] = ["status = 'user-edited'", "updated_at_ms = ?"];
  const params: Array<string | number | null> = [Date.now()];
  if (patch.issueKey !== undefined) {
    sets.push("issue_key = ?");
    params.push(patch.issueKey);
  }
  if (patch.startTime !== undefined) {
    sets.push("start_time = ?");
    params.push(patch.startTime);
  }
  if (patch.durationSeconds !== undefined) {
    sets.push("duration_seconds = ?");
    params.push(patch.durationSeconds);
  }
  if (patch.activityKey !== undefined) {
    sets.push("activity_key = ?");
    params.push(patch.activityKey);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description);
  }
  const info = getDb()
    .prepare(
      `UPDATE day_tempo_proposals SET ${sets.join(", ")} WHERE id = ? AND status IN ('proposed', 'user-edited')`,
    )
    .run(...params, id);
  return Number(info.changes) > 0;
}

/** Move a row to `pending-approval` (the tool persists the approval card). */
export function requestApproval(
  id: string,
  proposalEntryId: string | null,
): boolean {
  return transition(id, ["proposed", "user-edited"], "pending-approval", {
    proposalEntryId,
  });
}

/** Approve: CAS `pending-approval → executing`. The winning transition; only ONE call wins. */
export function beginExecuting(id: string): boolean {
  return transition(id, ["pending-approval"], "executing");
}

/** Finish a submission after `executing`. Cancellation is refused once executing. */
export function finishExecuting(
  id: string,
  outcome: "executed" | "partial" | "failed",
  resultWorklogId?: string | null,
  resultEntryId?: string | null,
): boolean {
  return transition(id, ["executing"], outcome, {
    resultWorklogId: resultWorklogId ?? null,
    resultEntryId: resultEntryId ?? null,
  });
}

/**
 * Cancel / drop a row. Wins ONLY from a pre-execution state — never once
 * `executing` (an external Tempo write may be in flight). Used for both an
 * explicit cancel and the proactive invalidation of a dropped/superseded row.
 */
export function cancelProposal(id: string): boolean {
  return transition(
    id,
    ["proposed", "user-edited", "pending-approval", "dropped"],
    "cancelled",
  );
}

/**
 * User-facing DECLINE (Task 144): a deliberate "don't log this" decision,
 * distinct from `cancelled` (system invalidation of a dropped/superseded row).
 * Wins only from a pre-execution state — never once `executing`. Terminal, so a
 * later re-run's `upsertProposal` preserves it and never re-proposes the row.
 */
export function declineProposal(id: string): boolean {
  return transition(
    id,
    ["proposed", "user-edited", "pending-approval"],
    "declined",
  );
}

export function resetTempoPlanStoreForTests(): void {
  getDb().prepare("DELETE FROM day_tempo_proposals").run();
}
