/**
 * SQL facade for the durable observation buffer (Task 91). Stores only bounded
 * clean human/assistant turn text plus the immutable source timestamp/timezone;
 * never raw tool output, binary, or sensitive bodies. The adaptive scheduler
 * (Task 99) claims/processes these; the processor (Task 98) consumes them.
 */
import type { MemoryObservationState } from "@assistant/shared";
import { getDb } from "./index.ts";

export interface MemoryObservation {
  id: number;
  sessionId: string;
  userTurnId: string;
  persona?: string;
  projectId?: string;
  humanText: string;
  assistantText?: string;
  /** Immutable authoritative source timestamp used to interpret relative dates. */
  sourceTimestampMs: number;
  /** Immutable IANA timezone snapshot used to interpret relative dates. */
  timezone: string;
  highSignal: boolean;
  state: MemoryObservationState;
  attempts: number;
  claimedAtMs?: number;
  createdAt: number;
  processedAtMs?: number;
  error?: string;
}

interface Row {
  id: number;
  session_id: string;
  user_turn_id: string;
  persona: string | null;
  project_id: string | null;
  human_text: string;
  assistant_text: string | null;
  source_timestamp_ms: number;
  timezone: string;
  high_signal: number;
  state: MemoryObservationState;
  attempts: number;
  claimed_at_ms: number | null;
  created_at_ms: number;
  processed_at_ms: number | null;
  error: string | null;
}

function fromRow(r: Row): MemoryObservation {
  return {
    id: r.id,
    sessionId: r.session_id,
    userTurnId: r.user_turn_id,
    ...(r.persona !== null ? { persona: r.persona } : {}),
    ...(r.project_id !== null ? { projectId: r.project_id } : {}),
    humanText: r.human_text,
    ...(r.assistant_text !== null ? { assistantText: r.assistant_text } : {}),
    sourceTimestampMs: r.source_timestamp_ms,
    timezone: r.timezone,
    highSignal: r.high_signal === 1,
    state: r.state,
    attempts: r.attempts,
    ...(r.claimed_at_ms !== null ? { claimedAtMs: r.claimed_at_ms } : {}),
    createdAt: r.created_at_ms,
    ...(r.processed_at_ms !== null ? { processedAtMs: r.processed_at_ms } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
  };
}

export interface MemoryObservationInsert {
  sessionId: string;
  userTurnId: string;
  persona?: string;
  projectId?: string;
  humanText: string;
  assistantText?: string;
  sourceTimestampMs: number;
  timezone: string;
  highSignal?: boolean;
  createdAt: number;
}

export const memoryObservationStore = {
  /** Enqueue an observation. Idempotent per (session, turn): a retry returns the existing row. */
  enqueue(input: MemoryObservationInsert): MemoryObservation {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO memory_observations (
        session_id, user_turn_id, persona, project_id, human_text, assistant_text,
        source_timestamp_ms, timezone, high_signal, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.userTurnId,
      input.persona ?? null,
      input.projectId ?? null,
      input.humanText,
      input.assistantText ?? null,
      input.sourceTimestampMs,
      input.timezone,
      input.highSignal ? 1 : 0,
      input.createdAt,
    );
    return this.find(input.sessionId, input.userTurnId)!;
  },

  find(sessionId: string, userTurnId: string): MemoryObservation | undefined {
    const row = getDb()
      .prepare(
        "SELECT * FROM memory_observations WHERE session_id = ? AND user_turn_id = ?",
      )
      .get(sessionId, userTurnId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  },

  get(id: number): MemoryObservation | undefined {
    const row = getDb()
      .prepare("SELECT * FROM memory_observations WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  },

  pending(limit = 50): MemoryObservation[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM memory_observations WHERE state = 'pending' ORDER BY created_at_ms, id LIMIT ?",
      )
      .all(limit) as unknown as Row[];
    return rows.map(fromRow);
  },

  pendingCount(): number {
    return (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_observations WHERE state = 'pending'",
        )
        .get() as { n: number }
    ).n;
  },

  /** Pending observations for ONE session (so a busy session cannot starve others). */
  pendingForSession(sessionId: string, limit = 50): MemoryObservation[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM memory_observations WHERE state = 'pending' AND session_id = ? ORDER BY created_at_ms, id LIMIT ?",
      )
      .all(sessionId, limit) as unknown as Row[];
    return rows.map(fromRow);
  },

  pendingCountForSession(sessionId: string): number {
    return (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_observations WHERE state = 'pending' AND session_id = ?",
        )
        .get(sessionId) as { n: number }
    ).n;
  },

  /**
   * Bound the durable queue by age, count, AND total characters. Discards pending
   * observations (oldest first) that are older than `maxAgeMs`, beyond
   * `maxPending`, or beyond `maxChars` of retained human+assistant text. Returns
   * how many were discarded.
   */
  prunePending(
    nowMs: number,
    maxPending: number,
    maxAgeMs: number,
    maxChars: number,
  ): number {
    const db = getDb();
    const discard = db.prepare(
      "UPDATE memory_observations SET state = 'discarded', human_text = '', assistant_text = NULL WHERE id = ? AND state = 'pending'",
    );
    let discarded = Number(
      db
        .prepare(
          "UPDATE memory_observations SET state = 'discarded', human_text = '', assistant_text = NULL WHERE state = 'pending' AND created_at_ms < ?",
        )
        .run(nowMs - maxAgeMs).changes,
    );
    // Newest-first; keep within count + char budgets, discard the older overflow.
    const rows = db
      .prepare(
        "SELECT id, LENGTH(human_text) + LENGTH(COALESCE(assistant_text, '')) AS chars FROM memory_observations WHERE state = 'pending' ORDER BY created_at_ms DESC, id DESC",
      )
      .all() as Array<{ id: number; chars: number }>;
    let kept = 0;
    let charSum = 0;
    for (const row of rows) {
      kept += 1;
      charSum += row.chars;
      if (kept > maxPending || charSum > maxChars)
        discarded += Number(discard.run(row.id).changes);
    }
    return discarded;
  },

  /**
   * Atomically claim a set of pending observations for processing (state →
   * processing, attempts + 1, claim time recorded). Returns the claimed rows.
   */
  claim(ids: number[], atMs: number): MemoryObservation[] {
    if (ids.length === 0) return [];
    const db = getDb();
    const stmt = db.prepare(
      "UPDATE memory_observations SET state = 'processing', attempts = attempts + 1, claimed_at_ms = ? WHERE id = ? AND state = 'pending'",
    );
    const claimed: MemoryObservation[] = [];
    for (const id of ids) {
      if (stmt.run(atMs, id).changes === 1) {
        const obs = this.get(id);
        if (obs) claimed.push(obs);
      }
    }
    return claimed;
  },

  mark(
    id: number,
    state: MemoryObservationState,
    atMs: number,
    error?: string,
  ): void {
    getDb()
      .prepare(
        "UPDATE memory_observations SET state = ?, processed_at_ms = ?, error = ? WHERE id = ?",
      )
      .run(
        state,
        state === "processed" || state === "discarded" || state === "failed"
          ? atMs
          : null,
        error ?? null,
        id,
      );
  },

  /** Return a claimed observation to pending (recoverable failure / bounded retry). */
  release(id: number): void {
    getDb()
      .prepare(
        "UPDATE memory_observations SET state = 'pending', claimed_at_ms = NULL WHERE id = ? AND state = 'processing'",
      )
      .run(id);
  },

  /**
   * Recover observations stuck in `processing` past `staleBeforeMs` (a crash left
   * them claimed): return them to `pending` so a restart can resume them.
   */
  recoverStale(staleBeforeMs: number): number {
    return Number(
      getDb()
        .prepare(
          "UPDATE memory_observations SET state = 'pending', claimed_at_ms = NULL WHERE state = 'processing' AND (claimed_at_ms IS NULL OR claimed_at_ms < ?)",
        )
        .run(staleBeforeMs).changes,
    );
  },

  /** Drop the retained text of a processed observation while keeping the audit row. */
  scrubProcessed(id: number): void {
    getDb()
      .prepare(
        "UPDATE memory_observations SET human_text = '', assistant_text = NULL WHERE id = ? AND state = 'processed'",
      )
      .run(id);
  },
};
