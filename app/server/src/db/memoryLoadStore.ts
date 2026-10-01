/**
 * SQL facade for effective-memory delivery state (Task 91): the per-session last
 * delivered snapshot (for reuse/clearing decisions and cumulative-injection
 * diagnostics) and the per-turn effective-load audit batches/items. Load batches
 * are audit records, never transcript messages.
 */
import type {
  EffectiveMemoryItem,
  MemoryLoadBatch,
  MemoryLoadDeliveryState,
  MemoryLoadItem,
  MemorySelectionReasonCode,
  MemorySourceKind,
} from "@assistant/shared";
import { getDb } from "./index.ts";

/** The persisted last-delivered snapshot for a session. */
export interface MemorySessionSnapshotRecord {
  sessionId: string;
  fingerprint: string;
  /** Ordered effective ids/revisions effective at delivery. */
  effective: Array<{ id: string; revision: number }>;
  renderedText: string;
  renderedChars: number;
  lastDeliveryState: MemoryLoadDeliveryState;
  lastDeliveryTurnId?: string;
  cumulativeInjectedChars: number;
  updatedAt: number;
}

interface SnapshotRow {
  session_id: string;
  fingerprint: string;
  effective_json: string;
  rendered_text: string;
  rendered_chars: number;
  last_delivery_state: MemoryLoadDeliveryState;
  last_delivery_turn_id: string | null;
  cumulative_injected_chars: number;
  updated_at_ms: number;
}

function fromSnapshotRow(r: SnapshotRow): MemorySessionSnapshotRecord {
  return {
    sessionId: r.session_id,
    fingerprint: r.fingerprint,
    effective: JSON.parse(r.effective_json) as Array<{
      id: string;
      revision: number;
    }>,
    renderedText: r.rendered_text,
    renderedChars: r.rendered_chars,
    lastDeliveryState: r.last_delivery_state,
    ...(r.last_delivery_turn_id !== null
      ? { lastDeliveryTurnId: r.last_delivery_turn_id }
      : {}),
    cumulativeInjectedChars: r.cumulative_injected_chars,
    updatedAt: r.updated_at_ms,
  };
}

interface BatchRow {
  id: number;
  session_id: string;
  user_turn_id: string;
  fingerprint: string;
  delivery_state: MemoryLoadDeliveryState;
  rendered_chars: number;
  injected_chars: number;
  cumulative_injected_chars: number;
  created_at_ms: number;
}

interface ItemRow {
  batch_id: number;
  rank: number;
  memory_id: string;
  revision: number;
  reason_code: string;
  reason: string;
  rendered_chars: number;
  text: string;
  kind: string;
  project_id: string | null;
  persona: string | null;
  temporal_label: string | null;
  source_kind: string | null;
  source_session_id: string | null;
  source_message_id: string | null;
}

export interface RecordLoadBatchInput {
  sessionId: string;
  userTurnId: string;
  fingerprint: string;
  deliveryState: MemoryLoadDeliveryState;
  renderedChars: number;
  injectedChars: number;
  cumulativeInjectedChars: number;
  createdAt: number;
  items: EffectiveMemoryItem[];
}

export const memoryLoadStore = {
  /* ------------------------------ snapshots ------------------------------- */

  getSnapshot(sessionId: string): MemorySessionSnapshotRecord | undefined {
    const row = getDb()
      .prepare("SELECT * FROM memory_session_snapshots WHERE session_id = ?")
      .get(sessionId) as SnapshotRow | undefined;
    return row ? fromSnapshotRow(row) : undefined;
  },

  putSnapshot(record: MemorySessionSnapshotRecord): void {
    getDb()
      .prepare(
        `INSERT INTO memory_session_snapshots (
        session_id, fingerprint, effective_json, rendered_text, rendered_chars,
        last_delivery_state, last_delivery_turn_id, cumulative_injected_chars, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        effective_json = excluded.effective_json,
        rendered_text = excluded.rendered_text,
        rendered_chars = excluded.rendered_chars,
        last_delivery_state = excluded.last_delivery_state,
        last_delivery_turn_id = excluded.last_delivery_turn_id,
        cumulative_injected_chars = excluded.cumulative_injected_chars,
        updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        record.sessionId,
        record.fingerprint,
        JSON.stringify(record.effective),
        record.renderedText,
        record.renderedChars,
        record.lastDeliveryState,
        record.lastDeliveryTurnId ?? null,
        record.cumulativeInjectedChars,
        record.updatedAt,
      );
  },

  /** Reset the cumulative-injected counter (called on detected compaction/rotation). */
  resetCumulativeInjected(sessionId: string, atMs: number): void {
    getDb()
      .prepare(
        "UPDATE memory_session_snapshots SET cumulative_injected_chars = 0, updated_at_ms = ? WHERE session_id = ?",
      )
      .run(atMs, sessionId);
  },

  clearSnapshot(sessionId: string): void {
    getDb()
      .prepare("DELETE FROM memory_session_snapshots WHERE session_id = ?")
      .run(sessionId);
  },

  /* ------------------------------ load batches ---------------------------- */

  /**
   * Persist one per-turn effective-load batch. Idempotent per (session, turn):
   * a retry of the same accepted turn replaces the prior batch + items so a
   * re-delivery does not duplicate audit rows.
   */
  recordBatch(input: RecordLoadBatchInput): MemoryLoadBatch {
    const db = getDb();
    db.prepare(
      "DELETE FROM memory_load_batches WHERE session_id = ? AND user_turn_id = ?",
    ).run(input.sessionId, input.userTurnId);
    const result = db
      .prepare(
        `INSERT INTO memory_load_batches (session_id, user_turn_id, fingerprint, delivery_state, rendered_chars, injected_chars, cumulative_injected_chars, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.userTurnId,
        input.fingerprint,
        input.deliveryState,
        input.renderedChars,
        input.injectedChars,
        input.cumulativeInjectedChars,
        input.createdAt,
      );
    const batchId = Number(result.lastInsertRowid);
    const itemStmt = db.prepare(
      "INSERT INTO memory_load_items (batch_id, rank, memory_id, revision, reason_code, reason, rendered_chars, text, kind, project_id, persona, temporal_label, source_kind, source_session_id, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of input.items) {
      itemStmt.run(
        batchId,
        item.rank,
        item.id,
        item.revision,
        item.reasonCode,
        item.reason,
        item.renderedChars,
        item.text,
        item.kind,
        item.scope.projectId ?? null,
        item.scope.persona ?? null,
        item.temporalLabel ?? null,
        item.provenance.sourceKind,
        item.provenance.sessionId ?? null,
        item.provenance.messageId ?? null,
      );
    }
    return this.getBatch(batchId)!;
  },

  getBatch(id: number): MemoryLoadBatch | undefined {
    const row = getDb()
      .prepare("SELECT * FROM memory_load_batches WHERE id = ?")
      .get(id) as BatchRow | undefined;
    return row ? this.hydrate(row) : undefined;
  },

  latestForSession(sessionId: string): MemoryLoadBatch | undefined {
    const row = getDb()
      .prepare(
        "SELECT * FROM memory_load_batches WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId) as BatchRow | undefined;
    return row ? this.hydrate(row) : undefined;
  },

  recentForSession(sessionId: string, limit = 20): MemoryLoadBatch[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM memory_load_batches WHERE session_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, limit) as unknown as BatchRow[];
    return rows.map((r) => this.hydrate(r));
  },

  hydrate(row: BatchRow): MemoryLoadBatch {
    const items = (
      getDb()
        .prepare(
          "SELECT * FROM memory_load_items WHERE batch_id = ? ORDER BY rank",
        )
        .all(row.id) as unknown as ItemRow[]
    ).map((i): MemoryLoadItem => {
      const personaValue = i.persona as MemoryLoadItem["scope"]["persona"];
      return {
        memoryId: i.memory_id,
        revision: i.revision,
        rank: i.rank,
        reasonCode: i.reason_code as MemorySelectionReasonCode,
        reason: i.reason,
        renderedChars: i.rendered_chars,
        text: i.text,
        kind: i.kind as MemoryLoadItem["kind"],
        scope: {
          ...(i.project_id !== null ? { projectId: i.project_id } : {}),
          ...(i.persona !== null
            ? {
                ...(personaValue !== undefined
                  ? { persona: personaValue }
                  : {}),
              }
            : {}),
        },
        ...(i.temporal_label !== null
          ? { temporalLabel: i.temporal_label }
          : {}),
        ...(i.source_kind !== null
          ? {
              provenance: {
                sourceKind: i.source_kind as MemorySourceKind,
                ...(i.source_session_id !== null
                  ? { sessionId: i.source_session_id }
                  : {}),
                ...(i.source_message_id !== null
                  ? { messageId: i.source_message_id }
                  : {}),
              },
            }
          : {}),
      };
    });
    return {
      id: row.id,
      sessionId: row.session_id,
      userTurnId: row.user_turn_id,
      fingerprint: row.fingerprint,
      deliveryState: row.delivery_state,
      renderedChars: row.rendered_chars,
      injectedChars: row.injected_chars,
      cumulativeInjectedChars: row.cumulative_injected_chars,
      createdAt: row.created_at_ms,
      items,
    };
  },
};
