/**
 * Migration regression for dropping Initiative attention (0096): applying
 * `0096_drop_initiative_attention.sql` to a database that holds Initiatives
 * keeps every row and its own columns, drops the attention cursor and the
 * manual Attention position, and moves every row's revision so a cached state
 * digest cannot keep the old summary.
 *   pnpm --filter @assistant/server test src/db/initiativeAttentionDropMigration.test.ts
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
const DROP_MIGRATION = "0096_drop_initiative_attention.sql";

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

function rows(db: DatabaseSync): Array<Record<string, unknown>> {
  return (
    db.prepare("SELECT * FROM initiatives ORDER BY id").all() as Array<
      Record<string, unknown>
    >
  ).map((row) => ({ ...row }));
}

function nextRevision(db: DatabaseSync): number | undefined {
  return (
    db
      .prepare(
        "SELECT next_id FROM sequences WHERE entity_type = 'initiative_revision'",
      )
      .get() as { next_id: number } | undefined
  )?.next_id;
}

test("existing Initiatives keep their data and lose only the attention columns", () => {
  const files = migrationFiles();
  const index = files.indexOf(DROP_MIGRATION);
  assert.ok(index > 0, "the attention drop migration ships");

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, files.slice(0, index));

  const insert = db.prepare(
    `INSERT INTO initiatives (
       id, title, description, state, revision, attention_revision,
       attention_settled_revision, attention_kind, attention_at_ms,
       created_at_ms, updated_at_ms, archived_at_ms, deleted_at_ms,
       inbox_position
     ) VALUES (?, ?, 'desc', ?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?)`,
  );
  insert.run(
    1,
    "Active",
    "active",
    4,
    1,
    0,
    "activity",
    100,
    100,
    null,
    null,
    2.5,
  );
  insert.run(
    2,
    "Paused",
    "paused",
    5,
    2,
    2,
    "paused",
    200,
    200,
    null,
    null,
    null,
  );
  insert.run(
    3,
    "Archived done",
    "done",
    3,
    1,
    1,
    "done",
    300,
    300,
    600,
    null,
    null,
  );
  insert.run(
    4,
    "Deleted",
    "active",
    6,
    1,
    0,
    "activity",
    400,
    400,
    null,
    700,
    null,
  );
  db.prepare(
    `INSERT INTO sequences (entity_type, next_id) VALUES ('initiative_revision', 7)
     ON CONFLICT(entity_type) DO UPDATE SET next_id = 7`,
  ).run();
  const before = rows(db);

  applyMigrations(db, [DROP_MIGRATION]);

  const after = rows(db);
  assert.equal(after.length, before.length, "no row is lost");
  assert.equal(nextRevision(db), 8, "the migration draws one new revision");
  const kept = [
    "id",
    "title",
    "description",
    "state",
    "created_at_ms",
    "updated_at_ms",
    "archived_at_ms",
    "deleted_at_ms",
  ];
  for (const [index, row] of before.entries()) {
    const migrated = after[index]!;
    assert.deepEqual(
      Object.keys(migrated).sort(),
      [...kept, "revision"].sort(),
      "only the Initiative's own columns remain",
    );
    for (const column of kept)
      assert.equal(
        migrated[column],
        row[column],
        `${String(row.title)}: ${column}`,
      );
    assert.equal(migrated.revision, 8, "a revision newer than any digest");
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});
