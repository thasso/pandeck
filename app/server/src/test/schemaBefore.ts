/**
 * A data directory's `app.sqlite3` as an earlier build left it: every shipped
 * migration before `migration` applied, with the bookkeeping the runner writes
 * (name and checksum), so a later `getDb()` sees a real upgrade. The caller
 * gets the raw connection to seed rows, and closes it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "db", "migrations");

export function databaseBefore(
  dataDir: string,
  migration: string,
): DatabaseSync {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const at = files.indexOf(migration);
  assert.ok(at > 0, `${migration} ships`);
  mkdirSync(dataDir, { recursive: true });
  const raw = new DatabaseSync(join(dataDir, "app.sqlite3"));
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )
  `);
  const record = raw.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, 1)",
  );
  for (const name of files.slice(0, at)) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const foreignKeysOff = sql.includes(
      "-- assistant:migration:foreign_keys_off",
    );
    if (foreignKeysOff) raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("BEGIN IMMEDIATE");
    raw.exec(sql);
    record.run(
      Number(name.split("_", 1)[0]),
      name,
      createHash("sha256").update(sql).digest("hex"),
    );
    raw.exec("COMMIT");
    if (foreignKeysOff) {
      raw.exec("PRAGMA legacy_alter_table = OFF");
      raw.exec("PRAGMA foreign_keys = ON");
    }
  }
  return raw;
}
