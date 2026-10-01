/**
 * Per-entity-type integer id allocation (see docs/tasks/PLAN.md, Topic 6).
 *
 * Each entity type has its own counter that increments by one, so ids are
 * contiguous per type (`task` → 1, 2, 3 …) and surface as
 * `Task-<n>`. Allocation is a single statement; callers should run it inside the
 * same transaction as the row insert so a failed insert leaves no gap.
 */
import { getDb } from "./index.ts";

/** Allocate and return the next id for an entity type (starts at 1). */
export function nextId(entityType: string): number {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO sequences (entity_type, next_id) VALUES (?, 1)
    ON CONFLICT(entity_type) DO UPDATE SET next_id = next_id + 1
  `,
  ).run(entityType);
  const row = db
    .prepare("SELECT next_id FROM sequences WHERE entity_type = ?")
    .get(entityType) as { next_id: number };
  return row.next_id;
}
