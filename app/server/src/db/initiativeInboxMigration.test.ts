/**
 * Migration regression for Initiative activity attention (0086): applying
 * `0086_initiative_inbox.sql` to a database that already holds Initiatives
 * keeps every row and its paused/done acknowledgement, wakes each active one
 * (which the inbox used to show unconditionally) as `activity`, adds the
 * manual position, and moves the revision of every row it changed so a cached
 * state digest cannot keep the old attention.
 *   pnpm --filter @assistant/server test src/db/initiativeInboxMigration.test.ts
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
const INBOX_MIGRATION = "0086_initiative_inbox.sql";

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

function byIdNow(db: DatabaseSync, id: number): Record<string, unknown> {
  return {
    ...(db.prepare("SELECT * FROM initiatives WHERE id = ?").get(id) as Record<
      string,
      unknown
    >),
  };
}

test("existing Initiatives keep their data; active ones wake as activity with a new revision", () => {
  const files = migrationFiles();
  const index = files.indexOf(INBOX_MIGRATION);
  assert.ok(index > 0, "the Initiative inbox migration ships");

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, files.slice(0, index));

  const insert = db.prepare(
    `INSERT INTO initiatives (
       id, title, description, state, revision, attention_revision,
       attention_settled_revision, attention_kind, attention_at_ms,
       created_at_ms, updated_at_ms, archived_at_ms, deleted_at_ms
     ) VALUES (?, ?, 'desc', ?, ?, ?, ?, ?, ?, 10, ?, ?, NULL)`,
  );
  insert.run(1, "Active", "active", 4, 0, 0, null, null, 100, null);
  // Paused once and settled, then made active again.
  insert.run(2, "Reactivated", "active", 5, 2, 2, "paused", 50, 200, null);
  insert.run(
    3,
    "Paused, unsettled",
    "paused",
    6,
    1,
    0,
    "paused",
    300,
    300,
    null,
  );
  insert.run(4, "Done, settled", "done", 7, 2, 2, "done", 400, 400, null);
  insert.run(5, "Archived done", "done", 3, 1, 1, "done", 500, 500, 600);
  db.prepare(
    `INSERT INTO sequences (entity_type, next_id) VALUES ('initiative_revision', 7)
     ON CONFLICT(entity_type) DO UPDATE SET next_id = 7`,
  ).run();
  const before = rows(db);

  applyMigrations(db, [INBOX_MIGRATION]);

  const after = rows(db);
  assert.equal(after.length, before.length, "no row is lost");
  assert.equal(nextRevision(db), 8, "the migration draws one new revision");
  const byId = new Map(after.map((row) => [row.id, row]));
  for (const row of before) {
    const migrated = byId.get(row.id)!;
    for (const column of [
      "title",
      "description",
      "state",
      "attention_settled_revision",
      "created_at_ms",
      "updated_at_ms",
      "archived_at_ms",
      "deleted_at_ms",
    ])
      assert.equal(
        migrated[column],
        row[column],
        `${String(row.title)}: ${column}`,
      );
    assert.equal(migrated.inbox_position, null, "no manual position yet");
    if (row.state === "active") {
      assert.deepEqual(
        {
          revision: migrated.revision,
          attention_revision: migrated.attention_revision,
          attention_kind: migrated.attention_kind,
          attention_at_ms: migrated.attention_at_ms,
        },
        {
          revision: 8,
          attention_revision: (row.attention_revision as number) + 1,
          attention_kind: "activity",
          attention_at_ms: row.updated_at_ms,
        },
        `${String(row.title)} wakes as activity at a revision newer than any digest`,
      );
    } else {
      for (const column of [
        "revision",
        "attention_revision",
        "attention_kind",
        "attention_at_ms",
      ])
        assert.equal(
          migrated[column],
          row[column],
          `${String(row.title)}: a paused/done acknowledgement survives (${column})`,
        );
    }
  }

  // The widened CHECK takes `activity` and still refuses anything else.
  db.prepare(
    "UPDATE initiatives SET attention_kind = 'activity' WHERE id = 3",
  ).run();
  assert.throws(
    () =>
      db
        .prepare("UPDATE initiatives SET attention_kind = 'other' WHERE id = 3")
        .run(),
    /CHECK constraint failed/,
  );
  db.prepare("UPDATE initiatives SET inbox_position = 12.5 WHERE id = 1").run();
  assert.equal(byIdNow(db, 1).inbox_position, 12.5);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});
