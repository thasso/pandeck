/**
 * Migration regression for 0101: every existing session row opens with no
 * pending runtime selection, and nothing else about it changes.
 *   pnpm --filter @assistant/server test src/db/sessionPendingRuntimeMigration.test.ts
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
const MIGRATION = "0101_session_pending_runtime.sql";

function apply(db: DatabaseSync, names: string[]): void {
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

test("existing sessions have no pending runtime selection after 0101", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const at = files.indexOf(MIGRATION);
  assert.ok(at > 0, "the migration exists");
  const db = new DatabaseSync(":memory:");
  apply(db, files.slice(0, at));
  const columns = db
    .prepare("PRAGMA table_info(session_index)")
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  const row: Record<string, string | number> = {
    id: "existing",
    scope: "user",
    harness: "pi",
    model: "gpt-5.5",
    credential_profile_id: "cp_a",
  };
  for (const column of columns) {
    if (column.name in row) continue;
    if (!column.notnull || column.dflt_value !== null) continue;
    row[column.name] = /INT|REAL|NUM/i.test(column.type) ? 1 : column.name;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO session_index (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((name) => row[name]!));
  apply(db, files.slice(at, at + 1));
  assert.deepEqual(
    db
      .prepare(
        "SELECT id, model, credential_profile_id, pending_runtime FROM session_index",
      )
      .all()
      .map((entry) => ({ ...entry })),
    [
      {
        id: "existing",
        model: "gpt-5.5",
        credential_profile_id: "cp_a",
        pending_runtime: null,
      },
    ],
  );
  db.close();
});

test("existing queued messages stay ordinary queued rows after 0101, and nothing else may be stored as a kind", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const at = files.indexOf(MIGRATION);
  const db = new DatabaseSync(":memory:");
  apply(db, files.slice(0, at));
  db.prepare(
    "INSERT INTO session_prompt_queue (id, session_id, position, text, created_at_ms, updated_at_ms) VALUES ('q1', 's1', 0, 'queued before the upgrade', 1, 1)",
  ).run();
  apply(db, files.slice(at, at + 1));
  assert.deepEqual(
    db
      .prepare("SELECT id, text, kind FROM session_prompt_queue")
      .all()
      .map((entry) => ({ ...entry })),
    [{ id: "q1", text: "queued before the upgrade", kind: "queued" }],
  );
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO session_prompt_queue (id, session_id, position, text, created_at_ms, updated_at_ms, kind) VALUES ('q2', 's1', 1, 'x', 1, 1, 'sent')",
      )
      .run(),
  );
  db.close();
});
