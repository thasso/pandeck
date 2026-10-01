/**
 * Migration regression for event-based settlement (Task-674): applying
 * `0057_session_attention.sql` to a database that already holds settled and
 * unsettled sessions must not change where a single one of them stands. The
 * revision columns start at 0 acknowledged through 0, which is exactly what
 * makes an existing `settled_at_ms` still mean "settled" — the deployment that
 * introduces attention must not empty the Settled shelf.
 *   pnpm --filter @assistant/server test src/db/sessionAttentionMigration.test.ts
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
const ATTENTION_MIGRATION = "0057_session_attention.sql";

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

/** The one question every consumer asks; see `sessionStore.isSettled`. */
function settledRows(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM session_index
          WHERE settled_at_ms IS NOT NULL
            AND attention_revision <= attention_settled_revision
          ORDER BY id`,
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

test("existing settlement survives the attention migration untouched", () => {
  const files = migrationFiles();
  const index = files.indexOf(ATTENTION_MIGRATION);
  assert.ok(index > 0, "the session-attention migration ships");

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, files.slice(0, index));

  const insert = db.prepare(
    `INSERT INTO session_index (
       id, scope, purpose, harness, agent_type, title, created_at_ms,
       updated_at_ms, message_count, mode, settled_at_ms, read_at_ms,
       fork_auto_rename_pending
     ) VALUES (?, 'user', 'chat', 'pi', 'assistant', ?, 1, 2, 2, 'build', ?, 2, 0)`,
  );
  insert.run("shelved", "Settled before the migration", 1_700_000_000_000);
  insert.run("working", "Never settled", null);

  applyMigrations(db, [ATTENTION_MIGRATION]);

  assert.deepEqual(
    settledRows(db),
    ["shelved"],
    "the settled session stays settled and the working one stays out of the shelf",
  );
  // Spread: node:sqlite hands back null-prototype rows, which `deepEqual` will
  // not accept against a literal.
  const shelved = {
    ...(db
      .prepare(
        `SELECT settled_at_ms, attention_revision, attention_settled_revision,
              attention_kind, attention_at_ms
         FROM session_index WHERE id = 'shelved'`,
      )
      .get() as Record<string, unknown>),
  };
  assert.deepEqual(
    shelved,
    {
      settled_at_ms: 1_700_000_000_000,
      attention_revision: 0,
      attention_settled_revision: 0,
      attention_kind: null,
      attention_at_ms: null,
    },
    "settlement history is carried over verbatim, with no outcome invented for it",
  );

  // The first outcome after the deployment is revision 1, which is the first
  // thing that can take a pre-existing settlement back out of the shelf.
  db.prepare(
    `UPDATE session_index
        SET attention_revision = attention_revision + 1,
            attention_kind = 'completed', attention_at_ms = 3
      WHERE id = 'shelved'`,
  ).run();
  assert.deepEqual(
    settledRows(db),
    [],
    "and the first completion after it wakes the session",
  );
  db.close();
});
