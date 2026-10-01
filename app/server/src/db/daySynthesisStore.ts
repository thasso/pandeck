/**
 * The day-synthesis application journal store (Task 136, plan Decision #2).
 * Synchronous node:sqlite (WAL, durable at call time). Two tables:
 *
 * - `day_synthesis_runs`: run-level lifecycle (preflight → applying → applied)
 *   plus the single run-id-tagged KB commit hash. A non-terminal row at startup
 *   is a crash marker the reconciler repairs.
 * - `day_synthesis_candidate_tasks`: the UNIQUE candidate→Task mapping. INSERT
 *   OR IGNORE makes Task creation idempotent — a candidate can never get two
 *   Tasks, so a crash between Task creation and the KB commit resumes rather
 *   than duplicating.
 *
 * The store owns rows only; the apply protocol lives in
 * `../dayScan/synthesisApply.ts`.
 */
import { getDb } from "./index.ts";

export type DaySynthesisRunState = "preflight" | "applying" | "applied";

export interface DaySynthesisRunRow {
  runId: string;
  date: string;
  state: DaySynthesisRunState;
  kbCommit: string | null;
  atMs: number;
}

interface RunDbRow {
  run_id: string;
  date: string;
  state: DaySynthesisRunState;
  kb_commit: string | null;
  at_ms: number;
}

function toRow(row: RunDbRow): DaySynthesisRunRow {
  return {
    runId: row.run_id,
    date: row.date,
    state: row.state,
    kbCommit: row.kb_commit,
    atMs: row.at_ms,
  };
}

/** Start (or resume) a run at `preflight`. Idempotent: an existing row is returned unchanged. */
export function beginRun(runId: string, date: string): DaySynthesisRunRow {
  const existing = getRun(runId);
  if (existing) return existing;
  getDb()
    .prepare(
      "INSERT INTO day_synthesis_runs (run_id, date, state, kb_commit, at_ms) VALUES (?, ?, 'preflight', NULL, ?)",
    )
    .run(runId, date, Date.now());
  return getRun(runId)!;
}

export function getRun(runId: string): DaySynthesisRunRow | null {
  const row = getDb()
    .prepare("SELECT * FROM day_synthesis_runs WHERE run_id = ?")
    .get(runId) as RunDbRow | undefined;
  return row ? toRow(row) : null;
}

export function setRunState(
  runId: string,
  state: DaySynthesisRunState,
  kbCommit?: string | null,
): void {
  getDb()
    .prepare(
      "UPDATE day_synthesis_runs SET state = ?, kb_commit = COALESCE(?, kb_commit), at_ms = ? WHERE run_id = ?",
    )
    .run(state, kbCommit ?? null, Date.now(), runId);
}

/** Runs left in a non-terminal state (crash markers) for startup reconciliation. */
export function listUnterminatedRuns(): DaySynthesisRunRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM day_synthesis_runs WHERE state != 'applied' ORDER BY at_ms",
    )
    .all() as unknown as RunDbRow[];
  return rows.map(toRow);
}

/**
 * Idempotently record (or look up) the Task for a candidate. Returns the
 * EFFECTIVE task id: an existing mapping wins, so a re-run never creates a
 * second Task for the same candidate. `create` is only invoked when no mapping
 * exists yet.
 */
export function ensureCandidateTask(
  candidateId: string,
  runId: string,
  create: () => string,
): { taskId: string; created: boolean } {
  const existing = getCandidateTask(candidateId);
  if (existing) return { taskId: existing, created: false };
  const taskId = create();
  // INSERT OR IGNORE closes the race with a concurrent creator; re-read the winner.
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO day_synthesis_candidate_tasks (candidate_id, task_id, run_id, at_ms) VALUES (?, ?, ?, ?)",
    )
    .run(candidateId, taskId, runId, Date.now());
  const winner = getCandidateTask(candidateId)!;
  return { taskId: winner, created: winner === taskId };
}

function getCandidateTask(candidateId: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT task_id FROM day_synthesis_candidate_tasks WHERE candidate_id = ?",
    )
    .get(candidateId) as { task_id: string } | undefined;
  return row?.task_id ?? null;
}

/** Test seam: wipe both tables. */
export function resetDaySynthesisStoreForTests(): void {
  getDb().prepare("DELETE FROM day_synthesis_runs").run();
  getDb().prepare("DELETE FROM day_synthesis_candidate_tasks").run();
}
