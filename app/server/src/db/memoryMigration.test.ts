/**
 * Migration hygiene regression (review follow-up A): applying the ORIGINAL 0011
 * (which already ships the memory_load_items text/kind/scope columns) and then
 * every later migration must succeed with no duplicate-column error, and 0012
 * must add only cumulative_injected_chars.
 *   pnpm --filter @assistant/server test src/db/memoryMigration.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
}

test("0011 already ships the load-item snapshot columns; 0012 only adds cumulative_injected_chars", () => {
  const sql11 = readFileSync(join(MIGRATIONS_DIR, "0011_memory.sql"), "utf8");
  assert.ok(
    /memory_load_items[\s\S]*\btext TEXT/.test(sql11),
    "0011 declares memory_load_items.text",
  );
  assert.ok(
    /memory_load_items[\s\S]*\bpersona TEXT/.test(sql11),
    "0011 declares memory_load_items.persona",
  );
  const sql12 = readFileSync(
    join(MIGRATIONS_DIR, "0012_memory_load_columns.sql"),
    "utf8",
  );
  assert.ok(
    /ADD COLUMN cumulative_injected_chars/.test(sql12),
    "0012 adds cumulative_injected_chars",
  );
  assert.ok(
    !/memory_load_items ADD COLUMN/.test(sql12),
    "0012 must NOT re-add load-item columns",
  );
});

test("upgrade path: original 0011 → later migrations applies cleanly (no duplicate-column error)", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d+_.+\.sql$/.test(n))
    .sort();
  const db = new DatabaseSync(":memory:");
  // Simulate an existing DB by applying every migration in order exactly as the
  // runner would; the crux is that 0012 follows the real 0011 without collision.
  for (const name of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  const batchCols = columns(db, "memory_load_batches");
  assert.ok(
    batchCols.has("cumulative_injected_chars"),
    "cumulative_injected_chars present after 0012",
  );
  const itemCols = columns(db, "memory_load_items");
  for (const c of ["text", "kind", "project_id", "persona", "temporal_label"]) {
    assert.ok(itemCols.has(c), `memory_load_items.${c} present (from 0011)`);
  }
  db.close();
});

test("0015 widens delivery_state to accept 'failed' and preserves AUTOINCREMENT identity across the rebuild", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d+_.+\.sql$/.test(n))
    .sort();
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const upto0014 = files.filter((n) => Number(n.split("_", 1)[0]) <= 14);
  for (const name of upto0014)
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));

  // Seed a pre-0015 row so the rebuild must preserve its id and data.
  db.exec(
    `INSERT INTO memory_load_batches (id, session_id, user_turn_id, fingerprint, delivery_state, rendered_chars, injected_chars, cumulative_injected_chars, created_at_ms)
     VALUES (5, 's1', 't1', 'fp', 'injected', 10, 10, 10, 1000)`,
  );
  db.exec(
    "INSERT INTO memory_load_items (batch_id, rank, memory_id, revision, reason_code, reason, rendered_chars, text, kind) VALUES (5, 1, 'm1', 1, 'pinned', 'r', 10, 'text', 'fact')",
  );

  // 0015 is tagged `foreign_keys_off`: the real runner (db/index.ts) toggles the
  // pragma off for the rebuild and back on after — replicate that here since this
  // test execs the raw SQL directly rather than through the runner.
  const remaining = files.filter((n) => Number(n.split("_", 1)[0]) === 15);
  for (const name of remaining) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    db.exec("PRAGMA foreign_keys = ON");
  }

  // Preserved historical row + its child item survive the rebuild.
  const row = db
    .prepare("SELECT * FROM memory_load_batches WHERE id = 5")
    .get() as { delivery_state: string } | undefined;
  assert.ok(row, "historical row preserved");
  assert.equal(row!.delivery_state, "injected");
  const item = db
    .prepare("SELECT * FROM memory_load_items WHERE batch_id = 5")
    .get();
  assert.ok(item, "historical child item preserved (FK intact)");

  // The new 'failed' value is accepted.
  db.exec(
    "INSERT INTO memory_load_batches (session_id, user_turn_id, fingerprint, delivery_state, rendered_chars, injected_chars, created_at_ms) VALUES ('s1', 't2', 'fp2', 'failed', 0, 0, 2000)",
  );
  const failedRow = db
    .prepare("SELECT id FROM memory_load_batches WHERE user_turn_id = 't2'")
    .get() as { id: number };
  assert.ok(
    failedRow.id > 5,
    "AUTOINCREMENT continues past the preserved historical max id (no collision)",
  );

  // An invalid delivery_state is still rejected.
  assert.throws(() =>
    db.exec(
      "INSERT INTO memory_load_batches (session_id, user_turn_id, fingerprint, delivery_state, rendered_chars, injected_chars, created_at_ms) VALUES ('s1', 't3', 'fp3', 'bogus', 0, 0, 3000)",
    ),
  );

  db.close();
});
