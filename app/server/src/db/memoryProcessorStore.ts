/**
 * SQL facade for the global processor usage/cost ledger (Task 91). Enforces the
 * global call/hour and reported-cost/day ceilings across every session and mode,
 * and survives restart. Stores no reasoning or sensitive prompt bodies.
 *
 * A run is inserted as a `reserved` reservation BEFORE a model call (so the rate
 * gate counts in-flight calls), then reconciled to `success`/`error`/`skipped`
 * with a possibly-late reported cost.
 */
import { getDb } from "./index.ts";

export type MemoryProcessorOutcome =
  "reserved" | "success" | "error" | "skipped";

export interface MemoryProcessorRun {
  id: number;
  reservedAtMs: number;
  completedAtMs?: number;
  outcome: MemoryProcessorOutcome;
  trigger?: string;
  operationsApplied: number;
  costMicrosUsd?: number;
  createdAt: number;
}

interface Row {
  id: number;
  reserved_at_ms: number;
  completed_at_ms: number | null;
  outcome: MemoryProcessorOutcome;
  trigger: string | null;
  operations_applied: number;
  cost_micros_usd: number | null;
  created_at_ms: number;
}

function fromRow(r: Row): MemoryProcessorRun {
  return {
    id: r.id,
    reservedAtMs: r.reserved_at_ms,
    ...(r.completed_at_ms !== null ? { completedAtMs: r.completed_at_ms } : {}),
    outcome: r.outcome,
    ...(r.trigger !== null ? { trigger: r.trigger } : {}),
    operationsApplied: r.operations_applied,
    ...(r.cost_micros_usd !== null ? { costMicrosUsd: r.cost_micros_usd } : {}),
    createdAt: r.created_at_ms,
  };
}

export const memoryProcessorStore = {
  /** Count non-skipped calls reserved in [sinceMs, atMs]. Used for the calls/hour ceiling. */
  callsSince(sinceMs: number): number {
    return (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_processor_runs WHERE reserved_at_ms >= ? AND outcome != 'skipped'",
        )
        .get(sinceMs) as { n: number }
    ).n;
  },

  /** Sum reported cost (micros USD) for runs reserved since `sinceMs`. Used for the cost/day ceiling. */
  costMicrosSince(sinceMs: number): number {
    const row = getDb()
      .prepare(
        "SELECT COALESCE(SUM(cost_micros_usd), 0) AS c FROM memory_processor_runs WHERE reserved_at_ms >= ? AND cost_micros_usd IS NOT NULL",
      )
      .get(sinceMs) as { c: number };
    return row.c;
  },

  /** Insert a reservation row and return its id. */
  reserve(atMs: number, trigger?: string): number {
    const result = getDb()
      .prepare(
        "INSERT INTO memory_processor_runs (reserved_at_ms, outcome, trigger, created_at_ms) VALUES (?, 'reserved', ?, ?)",
      )
      .run(atMs, trigger ?? null, atMs);
    return Number(result.lastInsertRowid);
  },

  /** Reconcile a reservation with its final outcome, applied-op count, and reported cost. */
  reconcile(
    id: number,
    outcome: Exclude<MemoryProcessorOutcome, "reserved">,
    atMs: number,
    opts: { operationsApplied?: number; costMicrosUsd?: number } = {},
  ): void {
    getDb()
      .prepare(
        "UPDATE memory_processor_runs SET outcome = ?, completed_at_ms = ?, operations_applied = ?, cost_micros_usd = ? WHERE id = ?",
      )
      .run(
        outcome,
        atMs,
        opts.operationsApplied ?? 0,
        opts.costMicrosUsd ?? null,
        id,
      );
  },

  /**
   * Most recent reservation time per consolidation group (trigger
   * `consolidation:<groupKey>`), for fair round-robin rotation across scopes.
   */
  consolidationGroupLastRun(): Map<string, number> {
    const rows = getDb()
      .prepare(
        "SELECT trigger, MAX(reserved_at_ms) AS ts FROM memory_processor_runs WHERE trigger LIKE 'consolidation:%' GROUP BY trigger",
      )
      .all() as Array<{ trigger: string; ts: number }>;
    const out = new Map<string, number>();
    for (const r of rows)
      out.set(r.trigger.slice("consolidation:".length), r.ts);
    return out;
  },

  get(id: number): MemoryProcessorRun | undefined {
    const row = getDb()
      .prepare("SELECT * FROM memory_processor_runs WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  },

  recent(limit = 50): MemoryProcessorRun[] {
    const rows = getDb()
      .prepare("SELECT * FROM memory_processor_runs ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Row[];
    return rows.map(fromRow);
  },
};
