/**
 * Migration regression for Workflow Run attention (Task-677): applying
 * `0058_workflow_run_attention.sql` to a database that already holds runs must
 * not resurrect a single finished one into the inbox — a historical completed
 * or cancelled run starts with no cursor — while a run that is PAUSED right
 * now, and therefore already an inbox item, starts awake so that its Settle
 * means something.
 *   pnpm --filter @assistant/server test src/db/workflowRunAttentionMigration.test.ts
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
const ATTENTION_MIGRATION = "0058_workflow_run_attention.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

/** Apply migrations the way `runMigrations` does, one transaction each. */
function applyMigrations(db: DatabaseSync, names: string[]): void {
  for (const name of names) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const foreignKeysOff = sql.includes(
      "-- assistant:migration:foreign_keys_off",
    );
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    db.exec(sql);
    db.exec("COMMIT");
    if (foreignKeysOff) {
      db.exec("PRAGMA legacy_alter_table = OFF");
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/** The runs the inbox would wake for; see `pendingWorkflowRunAttention`. */
function awakeRuns(db: DatabaseSync): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM workflow_runs
          WHERE attention_revision > attention_settled_revision
          ORDER BY id`,
      )
      .all() as Array<{ id: number }>
  ).map((row) => row.id);
}

test("historical runs are not resurrected, and a paused one starts awake", () => {
  const files = migrationFiles();
  const index = files.indexOf(ATTENTION_MIGRATION);
  assert.ok(index > 0, "the run-attention migration ships");

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, files.slice(0, index));

  const insert = db.prepare(
    `INSERT INTO workflow_runs (
       id, task_id, recipe_id, recipe_version, lifecycle, lifecycle_reason,
       max_iterations, max_review_passes, created_at_ms, updated_at_ms, ended_at_ms
     ) VALUES (?, 1, 'code-delivery', 1, ?, ?, 3, 1, 1, ?, ?)`,
  );
  insert.run(1, "completed", null, 10, 10);
  insert.run(2, "cancelled", "user cancelled", 20, 20);
  insert.run(3, "paused", "implementer failed", 30, null);
  insert.run(4, "active", null, 40, null);

  applyMigrations(db, [ATTENTION_MIGRATION]);

  assert.deepEqual(
    awakeRuns(db),
    [3],
    "only the paused run wakes; the finished ones and the live one carry no event",
  );
  const paused = {
    ...(db
      .prepare(
        `SELECT attention_revision, attention_settled_revision, attention_kind,
                attention_at_ms
           FROM workflow_runs WHERE id = 3`,
      )
      .get() as Record<string, unknown>),
  };
  assert.deepEqual(
    paused,
    {
      attention_revision: 1,
      attention_settled_revision: 0,
      attention_kind: "paused",
      attention_at_ms: 30,
    },
    "the pause the run already holds is its current event",
  );
  const completed = {
    ...(db
      .prepare(
        `SELECT attention_revision, attention_settled_revision, attention_kind,
                attention_at_ms
           FROM workflow_runs WHERE id = 1`,
      )
      .get() as Record<string, unknown>),
  };
  assert.deepEqual(
    completed,
    {
      attention_revision: 0,
      attention_settled_revision: 0,
      attention_kind: null,
      attention_at_ms: null,
    },
    "a historical completion invents no outcome for itself",
  );
  db.close();
});
